/**
 * 课表视图的**纯逻辑**（无 React、无 DOM）—— 因此能被 `node --test` 直接测。
 *
 * 为什么要单独一个模块：课表最容易错的不是画格子，是**口径**——
 * "第几周"按周一算还是周日算、"空周次"表示每周还是不排课、
 * 两门课撞在同一节时谁排左谁排右。这些东西一旦写进组件就没法测，
 * 而这个项目的硬规矩是"判定进纯函数、组件只负责渲染"（见 .dsh/skills/dsh-plugin-change）。
 *
 * ## 三个口径（与 DB 一致，改动要三处同步）
 *
 * 1. `weekday`：**0 = 周日**，与课表列顺序一致（参照企业微信课表截图：周日在最左）。
 * 2. 节次：**1-based**，`startSection` 是第几节开始，`sectionCount` 是连续几节。
 * 3. 周次：`weeks` **空数组 = 每周都上**（不是"不上"）。
 */

/** 课表列顺序：周日在最左（与企业微信课表一致），所以 0..6 直接映射到列。 */
export const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const

/** 简写（格子太窄时用）。 */
export const WEEKDAY_SHORT = ['日', '一', '二', '三', '四', '五', '六'] as const

/**
 * 节次时间表的**唯一权威定义**在 `shared/timetable.ts`（服务端给缺省值也要用同一份）。
 * 这里只做 re-export，不另写一份 —— 两份默认节次表 = 两套口径。
 */
import type { SectionTime as SharedSectionTime } from '../shared/timetable.js'
export { DEFAULT_SECTION_TIMES, DEFAULT_TOTAL_WEEKS, TIMETABLE_SECTION_COUNT, TIMETABLE_SECTION_COUNT as SECTION_COUNT } from '../shared/timetable.js'
export type { SectionTime } from '../shared/timetable.js'

/**
 * 课程配色（参照企业微信课表的实色底 + 白字）。
 *
 * 分配规则与截图**故意不同**：截图里同一门「高等数学I1」三处颜色不同（按记录轮询），
 * 那会让人误以为是三门课。这里按**课程名哈希**取色，同名同色 —— 这是人看课表的常规期待。
 */
export const COURSE_PALETTE = [
  '#E86363', // 红
  '#E8975A', // 橙
  '#E07BA0', // 粉
  '#4FAC6A', // 绿
  '#3F6FD8', // 蓝
  '#3FB0C8', // 青
  '#E8C33F', // 黄
  '#9B8ADE', // 紫
] as const

/** 稳定哈希：同名课程跨周同年同色。 */
export function courseColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0
  }
  return COURSE_PALETTE[Math.abs(hash) % COURSE_PALETTE.length]
}

export interface CourseLike {
  id: string
  name: string
  teacher: string
  location: string
  weekday: number
  startSection: number
  sectionCount: number
  weeks: number[]
  color: string | null
  archived?: number
}

/** 这门课在某周是否要上。`weeks` 为空 = 每周。 */
export function courseRunsInWeek(course: Pick<CourseLike, 'weeks'>, weekNumber: number): boolean {
  if (course.weeks.length === 0) return true
  return course.weeks.includes(weekNumber)
}

/** 某天的日期（`weekStart` 是这一周的**周日**，与列顺序一致）。 */
export function dateOfWeekday(weekStart: Date, weekday: number): Date {
  const date = new Date(weekStart)
  date.setDate(date.getDate() + weekday)
  return date
}

/** 这一周的第一天（周日 00:00）。 */
export function startOfScheduleWeek(date: Date): Date {
  const x = new Date(date)
  x.setHours(0, 0, 0, 0)
  x.setDate(x.getDate() - x.getDay())
  return x
}

/**
 * 某日期是学期第几周（1-based）。
 *
 * `semesterStart` 是学期**第一周的周日**（与列顺序一致）。返回 `null` = 不在学期内
 * （早于开学），界面据此显示"未开学"而不是画出第 0 周。
 */
export function weekNumberFor(semesterStart: Date, date: Date): number | null {
  const start = startOfScheduleWeek(semesterStart)
  const target = startOfScheduleWeek(date)
  const diffDays = Math.round((target.getTime() - start.getTime()) / 86_400_000)
  if (diffDays < 0) return null
  return Math.floor(diffDays / 7) + 1
}

/** 第 `weekNumber` 周的周日（1-based；`null` 输入返回 `null`）。 */
export function weekStartFor(semesterStart: Date, weekNumber: number): Date | null {
  if (!Number.isInteger(weekNumber) || weekNumber < 1) return null
  const start = startOfScheduleWeek(semesterStart)
  start.setDate(start.getDate() + (weekNumber - 1) * 7)
  return start
}

export interface PlacedCourse<T extends CourseLike> {
  course: T
  /** 列序号（0-based）：同一时段撞课时并排，左起第几列。 */
  column: number
  /** 这个冲突簇共几列（用于算每列宽度）。 */
  columnCount: number
}

/**
 * 把一天的课排成并排列（撞课处理）。
 *
 * 算法：按开始节次排序 → 把**互相重叠的课**划进同一个连通簇 → 簇内贪心占列。
 * 与 Google Calendar 的 column layout 同一思路；边界相接（第 1-2 节 与 第 3-4 节）
 * 不算重叠 —— 课表里那是"连着上"，不是撞车。
 */
export function layoutDayCourses<T extends CourseLike>(courses: readonly T[]): PlacedCourse<T>[] {
  const sorted = [...courses].sort((a, b) => a.startSection - b.startSection || a.name.localeCompare(b.name))
  const placed: PlacedCourse<T>[] = []
  let cluster: T[] = []
  let clusterEnd = 0

  const flush = (): void => {
    if (cluster.length === 0) return
    // 簇内贪心占列：找第一个"该列最后结束节次 < 本课开始节次"的列
    const columnEnds: number[] = []
    const assignment: Array<{ course: T; column: number }> = []
    for (const item of cluster) {
      const end = item.startSection + item.sectionCount - 1
      let column = columnEnds.findIndex((lastEnd) => lastEnd < item.startSection)
      if (column === -1) {
        column = columnEnds.length
        columnEnds.push(end)
      } else {
        columnEnds[column] = end
      }
      assignment.push({ course: item, column })
    }
    const columnCount = columnEnds.length
    for (const entry of assignment) placed.push({ ...entry, columnCount })
    cluster = []
    clusterEnd = 0
  }

  for (const course of sorted) {
    const end = course.startSection + course.sectionCount - 1
    if (cluster.length > 0 && course.startSection > clusterEnd) flush()
    cluster.push(course)
    clusterEnd = Math.max(clusterEnd, end)
  }
  flush()
  return placed
}

/** 某一天要画的课（已按周次过滤并排好列）。 */
export function dayCoursesFor<T extends CourseLike>(courses: readonly T[], weekday: number, weekNumber: number): PlacedCourse<T>[] {
  const dayCourses = courses.filter((course) => course.weekday === weekday && courseRunsInWeek(course, weekNumber))
  return layoutDayCourses(dayCourses)
}

/**
 * 周次输入的解析（"1-16" / "1,3,5-8" / "1-16单"）。
 *
 * 为什么要它：课表最常见的录入方式就是照抄教务系统那串周次，
 * 让用户一格一格点 16 次是反人类的。解析不出来就**抛错并回显原串**，不静默当每周。
 */
export function parseWeeksInput(text: string, maxWeek = 60): number[] {
  const source = text.trim()
  if (source === '') return []
  // 去掉中文与常见后缀标记，"1-16单" → "1-16"
  const oddOnly = /单$/.test(source)
  const evenOnly = /双$/.test(source)
  const cleaned = source.replace(/[单双]$/, '').replace(/[，、]/g, ',')
  const weeks = new Set<number>()
  for (const part of cleaned.split(',')) {
    const segment = part.trim()
    if (segment === '') continue
    const range = /^(\d+)\s*[-–~]\s*(\d+)$/.exec(segment)
    if (range !== null) {
      const from = Number(range[1])
      const to = Number(range[2])
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > maxWeek || from > to) {
        throw new Error(`周次范围不合法：${segment}（应在 1–${maxWeek} 之间且左端不大于右端）`)
      }
      for (let i = from; i <= to; i += 1) weeks.add(i)
      continue
    }
    if (!/^\d+$/.test(segment)) throw new Error(`周次里出现了看不懂的片段：${segment}（支持 1-16、1,3,5-8、1-16单）`)
    const value = Number(segment)
    if (value < 1 || value > maxWeek) throw new Error(`周次超出范围：${segment}（应在 1–${maxWeek} 之间）`)
    weeks.add(value)
  }
  let result = [...weeks].sort((a, b) => a - b)
  if (oddOnly) result = result.filter((week) => week % 2 === 1)
  if (evenOnly) result = result.filter((week) => week % 2 === 0)
  return result
}

/** 周次数组 → 可读文本（"每周" / "1-16" / "1,3,5-8"）。 */
export function formatWeeks(weeks: readonly number[]): string {
  if (weeks.length === 0) return '每周'
  const sorted = [...new Set(weeks)].sort((a, b) => a - b)
  const parts: string[] = []
  let rangeStart = sorted[0]
  let previous = sorted[0]
  const pushRange = (): void => {
    parts.push(rangeStart === previous ? String(rangeStart) : `${rangeStart}-${previous}`)
  }
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] === previous + 1) {
      previous = sorted[i]
      continue
    }
    pushRange()
    rangeStart = sorted[i]
    previous = sorted[i]
  }
  pushRange()
  return parts.join(',')
}

/** 节次区间 → CSS grid 行号（`grid-row: start / end`，1-based 且 end 不含）。 */
export function sectionGridRow(startSection: number, sectionCount: number): { rowStart: number; rowEnd: number } {
  return { rowStart: startSection, rowEnd: startSection + sectionCount }
}

/** 第 `index` 节的时间范围文本（"08:30–09:15"）。 */
export function sectionTimeLabel(sections: readonly SharedSectionTime[], index: number): string {
  const section = sections.find((item) => item.index === index)
  return section === undefined ? '' : `${section.start}–${section.end}`
}

/** 'HH:MM' → 距当天 00:00 的分钟数（非法值返回 NaN，调用方据此跳过而不是当成 0 点）。 */
export function minutesOfDay(hhmm: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (match === null) return Number.NaN
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return Number.NaN
  return hours * 60 + minutes
}

/** 一个日期是星期几（0 = 周日，与课表列口径一致）。 */
function weekdayOf(date: Date): number {
  return date.getDay()
}

/** 「今天的课」一条：课程 + 节次文案 + 当天的时间窗（分钟）。 */
export interface DayCourseEntry<T extends CourseLike> {
  course: T
  /** "第 3-4 节"。 */
  sectionLabel: string
  /** "10:25–12:00"（节次时间表缺项时为空串）。 */
  timeLabel: string
  /** 距当天 00:00 的分钟数；取不到时间时为 `null`。 */
  startMinutes: number | null
  endMinutes: number | null
}

/**
 * 某一天要上的课（按开始时间排序）。
 *
 * 口径：
 * - 按 `weekday` 过滤，再按**周次**过滤（`weeks` 为空 = 每周）；
 * - 学期起始日算不出周次（还没开学）时返回**空数组**，不猜；
 * - 撞课的课都返回（界面自己决定怎么并排/折叠）—— 今日视图是列表，不是网格。
 */
export function coursesOnDate<T extends CourseLike>(
  courses: readonly T[],
  date: Date,
  semester: { semesterStart: Date; totalWeeks: number },
  sectionTimes: readonly SharedSectionTime[],
): Array<DayCourseEntry<T>> {
  const weekNumber = weekNumberFor(semester.semesterStart, date)
  if (weekNumber === null || weekNumber < 1 || weekNumber > Math.max(semester.totalWeeks, 1)) return []
  const weekday = weekdayOf(date)
  return courses
    .filter((course) => course.weekday === weekday && courseRunsInWeek(course, weekNumber))
    .map((course) => {
      const first = sectionTimes.find((item) => item.index === course.startSection)
      const last = sectionTimes.find((item) => item.index === course.startSection + course.sectionCount - 1)
      const startMinutes = first === undefined ? Number.NaN : minutesOfDay(first.start)
      const endMinutes = last === undefined ? Number.NaN : minutesOfDay(last.end)
      return {
        course,
        sectionLabel: `第 ${course.startSection}-${course.startSection + course.sectionCount - 1} 节`,
        timeLabel: first === undefined || last === undefined ? '' : `${first.start}–${last.end}`,
        startMinutes: Number.isNaN(startMinutes) ? null : startMinutes,
        endMinutes: Number.isNaN(endMinutes) ? null : endMinutes,
      }
    })
    .sort((a, b) => (a.startMinutes ?? 0) - (b.startMinutes ?? 0) || a.course.name.localeCompare(b.course.name))
}

/**
 * 下一节还没开始的课（`now` 用距当天 00:00 的分钟数）。
 *
 * 正在上的课**不算下一节** —— 上课中要显示"正在上"，那是另一个判定
 * （`ongoingCourse`），混在一起会让倒计时指向正在上的那节（"还有 -5 分钟"）。
 */
export function nextCourse<T extends CourseLike>(entries: ReadonlyArray<DayCourseEntry<T>>, nowMinutes: number): DayCourseEntry<T> | null {
  for (const entry of entries) {
    if (entry.startMinutes !== null && entry.startMinutes > nowMinutes) return entry
  }
  return null
}

/** 正在上的课（`start <= now < end`）。撞课时取最早开始的那门。 */
export function ongoingCourse<T extends CourseLike>(entries: ReadonlyArray<DayCourseEntry<T>>, nowMinutes: number): DayCourseEntry<T> | null {
  for (const entry of entries) {
    if (entry.startMinutes === null || entry.endMinutes === null) continue
    if (nowMinutes >= entry.startMinutes && nowMinutes < entry.endMinutes) return entry
  }
  return null
}

/** 当前时刻（距当天 00:00 的分钟数），给倒计时用；由调用方注入 `Date` 以便测试。 */
export function minutesNow(now: Date): number {
  return now.getHours() * 60 + now.getMinutes()
}

/** "35 分钟" / "1 小时 05 分" 这类可读时长。 */
export function formatRemaining(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '即将开始'
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${String(rest).padStart(2, '0')} 分`
}
