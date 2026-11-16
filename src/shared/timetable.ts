/**
 * 课表的**共享常量**（前后端都要用：服务端给缺省值、客户端画网格）。
 *
 * 放在 `shared/` 而不是 `client/`：服务端的课表设置端点要用同一份默认节次表，
 * 客户端与服务端各写一份 = 两套口径（本项目 §0 的 bug 类别）。
 *
 * 本文件只放类型与纯常量，不 import 任何运行时依赖。
 */

/** 一天最多 12 节（与企业微信课表一致）。与 DB 的 `MAX_SECTIONS_PER_DAY` 同口径。 */
export const TIMETABLE_SECTION_COUNT = 12

/** 一节 = 45 分钟；两节连堂 95 分钟（见 DEFAULT_SECTION_TIMES）。 */
export interface SectionTime {
  /** 第几节（1-based）。 */
  index: number
  /** 'HH:MM'。 */
  start: string
  /** 'HH:MM'。 */
  end: string
}

/**
 * 缺省节次时间表（广州大学作息）。
 *
 * 与用户库里实际出现的四个上课时间（08:30 / 10:25 / 13:50 / 15:45）吻合：
 * 每节 45 分钟，两节连堂之间休息 5 分钟，上午/下午大节之间休息 25 分钟。
 * 这是**缺省**，设置里可改 —— 换学校、换学期都会变。
 */
export const DEFAULT_SECTION_TIMES: readonly SectionTime[] = [
  { index: 1, start: '08:30', end: '09:15' },
  { index: 2, start: '09:20', end: '10:05' },
  { index: 3, start: '10:25', end: '11:10' },
  { index: 4, start: '11:15', end: '12:00' },
  { index: 5, start: '13:50', end: '14:35' },
  { index: 6, start: '14:40', end: '15:25' },
  { index: 7, start: '15:45', end: '16:30' },
  { index: 8, start: '16:35', end: '17:20' },
  { index: 9, start: '18:30', end: '19:15' },
  { index: 10, start: '19:20', end: '20:05' },
  { index: 11, start: '20:15', end: '21:00' },
  { index: 12, start: '21:05', end: '21:50' },
]

/** 学期总周数的合法范围。 */
export const MIN_TOTAL_WEEKS = 1
export const MAX_TOTAL_WEEKS = 60
export const DEFAULT_TOTAL_WEEKS = 16

/** 课表设置（学期起始、总周数、节次时间表）。 */
export interface TimetableSettings {
  /** 学期第一周的**周日**（YYYY-MM-DD）。 */
  semesterStart: string
  totalWeeks: number
  sectionTimes: SectionTime[]
}

/**
 * 归一化节次时间表。
 *
 * 规则：**只接受合法的 1–12 节、HH:MM 起止、start < end**；非法项整表拒绝（抛错），
 * 不静默丢弃 —— 少一节会让网格行数变少，用户看到的课表凭空短一截。
 */
export function normalizeSectionTimes(input: unknown): SectionTime[] {
  if (input === undefined || input === null) return [...DEFAULT_SECTION_TIMES]
  if (!Array.isArray(input)) throw new Error('节次时间表必须是数组')
  const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/
  const result: SectionTime[] = []
  for (const [position, raw] of input.entries()) {
    if (typeof raw !== 'object' || raw === null) throw new Error(`第 ${position + 1} 个节次不是对象`)
    const item = raw as Record<string, unknown>
    const index = Number(item.index)
    if (!Number.isInteger(index) || index < 1 || index > TIMETABLE_SECTION_COUNT) {
      throw new Error(`节次序号不合法：${String(item.index)}（应在 1–${TIMETABLE_SECTION_COUNT}）`)
    }
    const start = String(item.start ?? '')
    const end = String(item.end ?? '')
    if (!timeRe.test(start) || !timeRe.test(end)) throw new Error(`第 ${index} 节的时间格式不合法：${start}–${end}（应为 HH:MM）`)
    if (start >= end) throw new Error(`第 ${index} 节的开始时间必须早于结束时间：${start}–${end}`)
    result.push({ index, start, end })
  }
  if (result.length === 0) throw new Error('节次时间表不能为空')
  result.sort((a, b) => a.index - b.index)
  return result
}

/** 学期起始日的合法形态（YYYY-MM-DD）。 */
export function isDateKey(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}
