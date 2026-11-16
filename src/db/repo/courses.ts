/**
 * 课表域（schema 20）：课程 CRUD。
 *
 * ## 为什么单独一域
 *
 * 课表是**节次网格**（星期几 + 第几节 + 几节连上 + 第几周），不是任意时间块。
 * 它与任务域没有共享判定：不进今日容量、不做验收/进度、不属于任何父任务。
 * 硬塞进 tasks 会让任务域的每条判定多一个"这门课不算任务"的特例（本项目 §0 的 bug 类别）。
 *
 * ## 校验口径（全部当场拒绝并给中文原因）
 *
 * 课表数据的错法很集中：星期超出 0–6、节次是 0 或负数、一周里节数荒谬。
 * 这些一旦落库，网格就会画出负高度或跑到列外面去。所以**在仓储层**拦，
 * 路由/工具/导入器全部走同一个 `normalizeCourseInput`，不存在第二份校验。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { nowIso } from './shared.js'

/** 节次上限：与企业微信课表一致，一天最多 12 节（超出的一律拒绝，不静默夹取）。 */
export const MAX_SECTIONS_PER_DAY = 12
/** 单门课最多连上几节（4 节 = 两节连堂 ×2，留余量）。 */
export const MAX_SECTION_SPAN = 8
/** 周次上限：一学期 60 周已经是极端值。 */
export const MAX_WEEK = 60

export interface CourseInput {
  /** 预分配 id（导入器要用；缺省生成 UUID）。 */
  id?: string
  name: string
  teacher?: string
  location?: string
  /** 0 = 周日 … 6 = 周六（与课表列顺序一致）。 */
  weekday: number
  /** 1-based 节次。 */
  startSection: number
  /** 连续节数，缺省 2（两节连堂）。 */
  sectionCount?: number
  /** 上课周次；**空数组 = 每周**。 */
  weeks?: number[]
  /** `null` = 按课程名自动着色。 */
  color?: string | null
  note?: string
}

export interface CoursePatch {
  name?: string
  teacher?: string
  location?: string
  weekday?: number
  startSection?: number
  sectionCount?: number
  weeks?: number[]
  color?: string | null
  note?: string
  archived?: boolean
}

export interface CourseRow {
  id: string
  name: string
  teacher: string
  location: string
  weekday: number
  startSection: number
  sectionCount: number
  weeks: number[]
  color: string | null
  note: string
  archived: number
  createdAt: string
  updatedAt: string
}

interface RawCourseRow {
  id: string
  name: string
  teacher: string
  location: string
  weekday: number
  start_section: number
  section_count: number
  weeks_json: string
  color: string | null
  note: string
  archived: number
  created_at: string
  updated_at: string
}

const COLOR_RE = /^#[0-9A-Fa-f]{6}$/

function parseIntInRange(value: unknown, min: number, max: number, label: string): number {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(num)) throw new Error(`${label}必须是整数：${String(value)}`)
  if (num < min || num > max) throw new Error(`${label}必须在 ${min}–${max} 之间：${num}`)
  return num
}

/** 周次：去重、升序、每个都在 1..MAX_WEEK。宽度异常整体拒绝，不静默丢弃坏项。 */
function normalizeWeeks(input: unknown): number[] {
  if (input === undefined || input === null) return []
  if (!Array.isArray(input)) throw new Error('上课周次必须是数字数组（如 [1,2,3]；空数组 = 每周）')
  const seen = new Set<number>()
  for (const raw of input) {
    seen.add(parseIntInRange(raw, 1, MAX_WEEK, '上课周次'))
  }
  return [...seen].sort((a, b) => a - b)
}

function normalizeColor(input: unknown): string | null {
  if (input === undefined || input === null) return null
  const text = String(input).trim()
  if (text === '') return null
  if (!COLOR_RE.test(text)) throw new Error(`颜色必须是 #RRGGBB 形式：${text}`)
  return text.toUpperCase()
}

function parseCourse(row: RawCourseRow): CourseRow {
  let weeks: number[] = []
  try {
    const parsed: unknown = JSON.parse(row.weeks_json)
    if (Array.isArray(parsed)) weeks = parsed.filter((n): n is number => Number.isInteger(n)).sort((a, b) => a - b)
  } catch {
    // 坏 JSON：当作"每周"，不猜内容（读取侧不因手工改库而崩）
    weeks = []
  }
  return {
    id: row.id,
    name: row.name,
    teacher: row.teacher,
    location: row.location,
    weekday: row.weekday,
    startSection: row.start_section,
    sectionCount: row.section_count,
    weeks,
    color: row.color,
    note: row.note,
    archived: row.archived,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** 同一时段的课会撞车：返回与给定节次区间重叠的其他课程（供界面提示，不阻止保存）。 */
export function findCourseConflicts(db: DatabaseSync, input: Pick<CourseRow, 'id' | 'weekday' | 'startSection' | 'sectionCount'>): CourseRow[] {
  const end = input.startSection + input.sectionCount - 1
  return listCourses(db).filter((course) => {
    if (course.id === input.id) return false
    if (course.weekday !== input.weekday) return false
    const otherEnd = course.startSection + course.sectionCount - 1
    return input.startSection <= otherEnd && course.startSection <= end
  })
}

export function listCourses(db: DatabaseSync, opts: { includeArchived?: boolean } = {}): CourseRow[] {
  const rows = (opts.includeArchived === true
    ? db.prepare('SELECT * FROM courses ORDER BY weekday, start_section, name').all()
    : db.prepare('SELECT * FROM courses WHERE archived = 0 ORDER BY weekday, start_section, name').all()) as unknown as RawCourseRow[]
  return rows.map(parseCourse)
}

export function getCourse(db: DatabaseSync, id: string): CourseRow | undefined {
  const row = db.prepare('SELECT * FROM courses WHERE id = ?').get(id) as RawCourseRow | undefined
  return row === undefined ? undefined : parseCourse(row)
}

export function createCourse(db: DatabaseSync, input: CourseInput, at = nowIso()): CourseRow {
  const name = String(input.name ?? '').trim()
  if (name === '') throw new Error('课程名不能为空')
  const weekday = parseIntInRange(input.weekday, 0, 6, '星期（0 = 周日，6 = 周六）')
  const startSection = parseIntInRange(input.startSection, 1, MAX_SECTIONS_PER_DAY, '开始节次')
  const sectionCount = parseIntInRange(input.sectionCount ?? 2, 1, MAX_SECTION_SPAN, '连续节数')
  if (startSection + sectionCount - 1 > MAX_SECTIONS_PER_DAY) {
    throw new Error(`这门课排到第 ${startSection + sectionCount - 1} 节，超出一天 ${MAX_SECTIONS_PER_DAY} 节的上限`)
  }
  const id = input.id !== undefined && String(input.id).trim() !== '' ? String(input.id).trim() : randomUUID()
  if (getCourse(db, id) !== undefined) throw new Error(`课程 id 已存在：${id}`)
  db.prepare(`
    INSERT INTO courses (id, name, teacher, location, weekday, start_section, section_count, weeks_json, color, note, archived, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(
    id, name, String(input.teacher ?? '').trim(), String(input.location ?? '').trim(),
    weekday, startSection, sectionCount, JSON.stringify(normalizeWeeks(input.weeks)),
    normalizeColor(input.color), String(input.note ?? ''), at, at,
  )
  return getCourse(db, id)!
}

export function updateCourse(db: DatabaseSync, id: string, patch: CoursePatch, at = nowIso()): CourseRow | undefined {
  const before = getCourse(db, id)
  if (before === undefined) return undefined
  const name = patch.name === undefined ? before.name : String(patch.name).trim()
  if (name === '') throw new Error('课程名不能为空')
  const weekday = patch.weekday === undefined ? before.weekday : parseIntInRange(patch.weekday, 0, 6, '星期（0 = 周日，6 = 周六）')
  const startSection = patch.startSection === undefined ? before.startSection : parseIntInRange(patch.startSection, 1, MAX_SECTIONS_PER_DAY, '开始节次')
  const sectionCount = patch.sectionCount === undefined ? before.sectionCount : parseIntInRange(patch.sectionCount, 1, MAX_SECTION_SPAN, '连续节数')
  if (startSection + sectionCount - 1 > MAX_SECTIONS_PER_DAY) {
    throw new Error(`这门课排到第 ${startSection + sectionCount - 1} 节，超出一天 ${MAX_SECTIONS_PER_DAY} 节的上限`)
  }
  db.prepare(`
    UPDATE courses SET name = ?, teacher = ?, location = ?, weekday = ?, start_section = ?,
      section_count = ?, weeks_json = ?, color = ?, note = ?, archived = ?, updated_at = ?
    WHERE id = ?
  `).run(
    name,
    patch.teacher === undefined ? before.teacher : String(patch.teacher).trim(),
    patch.location === undefined ? before.location : String(patch.location).trim(),
    weekday, startSection, sectionCount,
    patch.weeks === undefined ? JSON.stringify(before.weeks) : JSON.stringify(normalizeWeeks(patch.weeks)),
    patch.color === undefined ? before.color : normalizeColor(patch.color),
    patch.note === undefined ? before.note : String(patch.note),
    patch.archived === undefined ? before.archived : patch.archived ? 1 : 0,
    at, id,
  )
  return getCourse(db, id)
}

/**
 * 删课。
 *
 * 直接物理删除：课表是用户手输的低价值数据，没有验收/事件链要保留；
 * 归档（`archived = 1`）留给"这门课上完了但想留着看"的场景。
 */
export function deleteCourse(db: DatabaseSync, id: string): boolean {
  const existing = getCourse(db, id)
  if (existing === undefined) return false
  db.prepare('DELETE FROM courses WHERE id = ?').run(id)
  return true
}
