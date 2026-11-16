/**
 * 课表域路由（schema 20）：课程 CRUD。
 *
 * 与任务域同一套围栏：只接受回环请求、JSON body 走 `readJsonBody`、错误一律
 * `{ error: '中文原因' }` 400（不抛栈给前端）。
 *
 * 冲突提示放在响应里而不是拒绝写入：同一时段撞课是**用户可能故意**的
 * （单双周交替、换教室的同一门课），静默拒绝会让"我就是想两周各排一门"变成死路。
 * 所以 `conflicts` 只做提示，界面自己决定标不标黄。
 */
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { DatabaseSync } from 'node:sqlite'
import { createCourse, deleteCourse, findCourseConflicts, getCourse, listCourses, readMeta, updateCourse, writeMeta, type CourseInput, type CoursePatch } from '../../db/repo.js'
import { DEFAULT_SECTION_TIMES, DEFAULT_TOTAL_WEEKS, MAX_TOTAL_WEEKS, MIN_TOTAL_WEEKS, isDateKey, normalizeSectionTimes, type TimetableSettings } from '../../shared/timetable.js'
import { COURSES_PREFIX, isLoopbackRequest, pathSegments, readJsonBody, writeJson } from './helpers.js'

/**
 * 课表设置的三个 meta 键（唯一来源）。
 *
 * 为什么不塞进 `WorkbenchSettings` 大对象：课表设置只在课表页用，
 * 塞进全局设置会让每次 bootstrap 都多带一份节次表，也让设置页多三个不相干的字段。
 */
const SETTINGS_SEMESTER_START = 'timetable_semester_start'
const SETTINGS_TOTAL_WEEKS = 'timetable_total_weeks'
const SETTINGS_SECTION_TIMES = 'timetable_section_times'

/** 今天所在周的**周日**（缺省学期起始；用户到「课表设置」里改成真实开学周）。 */
function currentSunday(): string {
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  now.setDate(now.getDate() - now.getDay())
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function readTimetableSettings(db: DatabaseSync): TimetableSettings {
  const start = readMeta(db, SETTINGS_SEMESTER_START)
  const weeks = Number(readMeta(db, SETTINGS_TOTAL_WEEKS))
  const rawSections = readMeta(db, SETTINGS_SECTION_TIMES)
  let sectionTimes = [...DEFAULT_SECTION_TIMES]
  if (rawSections !== undefined) {
    try {
      sectionTimes = normalizeSectionTimes(JSON.parse(rawSections))
    } catch {
      // 库里存了坏值：**回退到默认而不是崩**，并在响应里如实回来（读到什么就是什么）
      sectionTimes = [...DEFAULT_SECTION_TIMES]
    }
  }
  return {
    semesterStart: isDateKey(start) ? start : currentSunday(),
    totalWeeks: Number.isInteger(weeks) && weeks >= MIN_TOTAL_WEEKS && weeks <= MAX_TOTAL_WEEKS ? weeks : DEFAULT_TOTAL_WEEKS,
    sectionTimes,
  }
}

/** 请求体 → CourseInput（只认显式给出的字段，缺的走缺省，不猜）。 */
function courseInputFromBody(body: Record<string, unknown>): CourseInput {
  return {
    name: typeof body.name === 'string' ? body.name : '',
    teacher: typeof body.teacher === 'string' ? body.teacher : undefined,
    location: typeof body.location === 'string' ? body.location : undefined,
    weekday: body.weekday as number,
    startSection: body.startSection as number,
    sectionCount: body.sectionCount === undefined ? undefined : body.sectionCount as number,
    weeks: body.weeks === undefined ? undefined : body.weeks as number[],
    color: body.color === null ? null : typeof body.color === 'string' ? body.color : undefined,
    note: typeof body.note === 'string' ? body.note : undefined,
  }
}

function coursePatchFromBody(body: Record<string, unknown>): CoursePatch {
  const patch: CoursePatch = {}
  if (typeof body.name === 'string') patch.name = body.name
  if (typeof body.teacher === 'string') patch.teacher = body.teacher
  if (typeof body.location === 'string') patch.location = body.location
  if (body.weekday !== undefined) patch.weekday = body.weekday as number
  if (body.startSection !== undefined) patch.startSection = body.startSection as number
  if (body.sectionCount !== undefined) patch.sectionCount = body.sectionCount as number
  if (body.weeks !== undefined) patch.weeks = body.weeks as number[]
  if (body.color === null) patch.color = null
  else if (typeof body.color === 'string') patch.color = body.color
  if (typeof body.note === 'string') patch.note = body.note
  if (body.archived === true || body.archived === false) patch.archived = body.archived
  return patch
}

export function makeCourseRoutes(db: DatabaseSync): WebRoute[] {
  return [
    {
      kind: 'prefix',
      path: COURSES_PREFIX,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        const url = new URL(req.url ?? '/', 'http://localhost')
        const segments = pathSegments(url, COURSES_PREFIX)
        const method = req.method ?? 'GET'
        const body = ['POST', 'PATCH'].includes(method) ? await readJsonBody(req) : undefined

        if (segments.length === 0) {
          if (method === 'GET') {
            const includeArchived = url.searchParams.get('archived') === 'true'
            return writeJson(res, 200, { ok: true, courses: listCourses(db, { includeArchived }) })
          }
          if (method === 'POST') {
            if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
            try {
              const course = createCourse(db, courseInputFromBody(body))
              const conflicts = findCourseConflicts(db, course)
              return writeJson(res, 201, { ok: true, course, conflicts })
            } catch (error) {
              return writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
            }
          }
          return writeJson(res, 405, { error: 'method not allowed' })
        }

        // ---- 课表设置（学期起始 / 总周数 / 节次时间表） ----
        // 必须排在"当作课程 id"之前，否则 `settings` 会被当成一门课的 id 去查。
        if (segments.length === 1 && segments[0] === 'settings') {
          if (method === 'GET') return writeJson(res, 200, { ok: true, settings: readTimetableSettings(db) })
          if (method === 'POST') {
            if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
            try {
              if (body.semesterStart !== undefined) {
                if (!isDateKey(body.semesterStart)) throw new Error(`学期起始日必须是 YYYY-MM-DD：${String(body.semesterStart)}`)
                writeMeta(db, SETTINGS_SEMESTER_START, body.semesterStart)
              }
              if (body.totalWeeks !== undefined) {
                const weeks = Number(body.totalWeeks)
                if (!Number.isInteger(weeks) || weeks < MIN_TOTAL_WEEKS || weeks > MAX_TOTAL_WEEKS) {
                  throw new Error(`学期总周数必须是 ${MIN_TOTAL_WEEKS}–${MAX_TOTAL_WEEKS} 的整数：${String(body.totalWeeks)}`)
                }
                writeMeta(db, SETTINGS_TOTAL_WEEKS, String(weeks))
              }
              if (body.sectionTimes !== undefined) {
                const sectionTimes = normalizeSectionTimes(body.sectionTimes)
                writeMeta(db, SETTINGS_SECTION_TIMES, JSON.stringify(sectionTimes))
              }
              return writeJson(res, 200, { ok: true, settings: readTimetableSettings(db) })
            } catch (error) {
              return writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
            }
          }
          return writeJson(res, 405, { error: 'method not allowed' })
        }

        const id = segments[0]
        if (segments.length > 1) return writeJson(res, 404, { error: 'not found' })

        if (method === 'GET') {
          const course = getCourse(db, id)
          if (course === undefined) return writeJson(res, 404, { error: 'course not found' })
          return writeJson(res, 200, { ok: true, course, conflicts: findCourseConflicts(db, course) })
        }
        if (method === 'PATCH') {
          if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
          try {
            const course = updateCourse(db, id, coursePatchFromBody(body))
            if (course === undefined) return writeJson(res, 404, { error: 'course not found' })
            return writeJson(res, 200, { ok: true, course, conflicts: findCourseConflicts(db, course) })
          } catch (error) {
            return writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
        }
        if (method === 'DELETE') {
          return deleteCourse(db, id)
            ? writeJson(res, 200, { ok: true })
            : writeJson(res, 404, { error: 'course not found' })
        }
        return writeJson(res, 405, { error: 'method not allowed' })
      },
    },
  ]
}
