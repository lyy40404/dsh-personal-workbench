/**
 * 课表纯逻辑的判据（`src/client/courseGrid.ts`）。
 *
 * 为什么值得单测：这里锁的是**三个口径**——周次、节次、撞课分列。
 * 它们错了不会崩，只会让课表"看起来对、实际排错一行"（第几周整体偏一周、
 * 两门撞课的课叠在一起看不见、单双周多上一半课）。这类错用户很难自己描述出来。
 *
 * 全部是纯函数，`node --test` 直接跑，不需要 DOM。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  courseColor, courseRunsInWeek, dateOfWeekday, dayCoursesFor, formatWeeks, layoutDayCourses,
  parseWeeksInput, sectionGridRow, sectionTimeLabel, startOfScheduleWeek, weekNumberFor, weekStartFor,
  DEFAULT_SECTION_TIMES, coursesOnDate, nextCourse, ongoingCourse, formatRemaining, minutesOfDay,
} from '../lib/client/courseGrid.js'

const course = (overrides = {}) => ({
  id: overrides.id ?? 'c1',
  name: overrides.name ?? '高等数学I1',
  teacher: overrides.teacher ?? '袁荣',
  location: overrides.location ?? '文新511（阶）',
  weekday: overrides.weekday ?? 1,
  startSection: overrides.startSection ?? 3,
  sectionCount: overrides.sectionCount ?? 2,
  weeks: overrides.weeks ?? [],
  color: overrides.color ?? null,
  archived: 0,
})

test('配色：同名同色，跨条目稳定', () => {
  assert.equal(courseColor('高等数学I1'), courseColor('高等数学I1'))
  assert.match(courseColor('高等数学I1'), /^#[0-9A-F]{6}$/)
})

test('周次口径：空数组 = 每周（不是"不上"）', () => {
  assert.equal(courseRunsInWeek({ weeks: [] }, 1), true)
  assert.equal(courseRunsInWeek({ weeks: [] }, 17), true)
  assert.equal(courseRunsInWeek({ weeks: [1, 3, 5] }, 3), true)
  assert.equal(courseRunsInWeek({ weeks: [1, 3, 5] }, 4), false)
})

test('周次输入解析：范围、逗号、单双周', () => {
  assert.deepEqual(parseWeeksInput(''), [])
  assert.deepEqual(parseWeeksInput('1-4'), [1, 2, 3, 4])
  assert.deepEqual(parseWeeksInput('1,3,5-8'), [1, 3, 5, 6, 7, 8])
  assert.deepEqual(parseWeeksInput('1-8单'), [1, 3, 5, 7])
  assert.deepEqual(parseWeeksInput('1-8双'), [2, 4, 6, 8])
  // 重复项去重、乱序排序
  assert.deepEqual(parseWeeksInput('3,1,3'), [1, 3])
})

test('周次输入解析：非法输入抛错，不静默当每周', () => {
  assert.throws(() => parseWeeksInput('5-1'), /不合法/)
  assert.throws(() => parseWeeksInput('0-3'), /不合法/)
  assert.throws(() => parseWeeksInput('abc'), /看不懂/)
  assert.throws(() => parseWeeksInput('1-99'), /不合法/)
})

test('周次格式化：与解析互为逆运算（常见形状）', () => {
  assert.equal(formatWeeks([]), '每周')
  assert.equal(formatWeeks([1, 2, 3, 4]), '1-4')
  assert.equal(formatWeeks([1, 3, 5]), '1,3,5')
  assert.equal(formatWeeks([1, 3, 5, 7]), '1,3,5,7')
  assert.deepEqual(parseWeeksInput(formatWeeks([2, 3, 9])), [2, 3, 9])
})

test('周日是每周第一天：startOfScheduleWeek 把周三折回周日', () => {
  const wednesday = new Date(2026, 10, 11) // 2026-11-11 周三
  const sunday = startOfScheduleWeek(wednesday)
  assert.equal(sunday.getDay(), 0)
  assert.equal(sunday.getDate(), 8) // 2026-11-08 是周日
})

test('weekNumberFor：开学当周 = 第 1 周，第 8 天 = 第 2 周，早于开学 = null', () => {
  const semesterStart = new Date(2026, 8, 6) // 2026-09-06 周日
  assert.equal(weekNumberFor(semesterStart, new Date(2026, 8, 6)), 1)
  assert.equal(weekNumberFor(semesterStart, new Date(2026, 8, 12)), 1) // 周六同周
  assert.equal(weekNumberFor(semesterStart, new Date(2026, 8, 13)), 2) // 下一周日
  assert.equal(weekNumberFor(semesterStart, new Date(2026, 8, 5)), null) // 开学前一天
})

test('weekStartFor：第 N 周 → 那周的周日，且与 weekNumberFor 互逆', () => {
  const semesterStart = new Date(2026, 8, 6)
  const week3 = weekStartFor(semesterStart, 3)
  assert.equal(week3.getDate(), 20)
  assert.equal(weekNumberFor(semesterStart, week3), 3)
  assert.equal(weekStartFor(semesterStart, 0), null)
})

test('dateOfWeekday：0 = 周日 … 6 = 周六', () => {
  const weekStart = new Date(2026, 10, 8)
  assert.equal(dateOfWeekday(weekStart, 0).getDate(), 8)
  assert.equal(dateOfWeekday(weekStart, 1).getDate(), 9)
  assert.equal(dateOfWeekday(weekStart, 6).getDate(), 14)
})

test('撞课分列：不重叠各占满一行，重叠并排', () => {
  const a = course({ id: 'a', startSection: 1, sectionCount: 2 })
  const b = course({ id: 'b', startSection: 3, sectionCount: 2 })
  const placed = layoutDayCourses([a, b])
  assert.deepEqual(placed.map((p) => p.column), [0, 0])
  assert.deepEqual(placed.map((p) => p.columnCount), [1, 1])

  const overlapping = layoutDayCourses([
    course({ id: 'x', startSection: 1, sectionCount: 2 }),
    course({ id: 'y', startSection: 2, sectionCount: 2 }),
  ])
  assert.deepEqual(overlapping.map((p) => p.column), [0, 1])
  assert.deepEqual(overlapping.map((p) => p.columnCount), [2, 2])
})

test('撞课分列：三节课各自错开时复用列，不无限加宽', () => {
  const placed = layoutDayCourses([
    course({ id: 'p', startSection: 1, sectionCount: 2 }), // 1-2
    course({ id: 'q', startSection: 2, sectionCount: 2 }), // 2-3 与上重叠
    course({ id: 'r', startSection: 3, sectionCount: 2 }), // 3-4 与上重叠，但 1-2 已空
  ])
  assert.equal(Math.max(...placed.map((p) => p.columnCount)), 2)
  assert.deepEqual(placed.map((p) => p.column), [0, 1, 0])
})

test('dayCoursesFor：按星期过滤 + 按周次过滤 + 已分列', () => {
  const courses = [
    course({ id: 'mon-w1', weekday: 1, weeks: [1] }),
    course({ id: 'mon-all', weekday: 1, weeks: [] }),
    course({ id: 'tue-all', weekday: 2, weeks: [] }),
  ]
  const week2 = dayCoursesFor(courses, 1, 2)
  assert.deepEqual(week2.map((p) => p.course.id), ['mon-all'])
  const week1 = dayCoursesFor(courses, 1, 1)
  assert.equal(week1.length, 2)
})

test('节次 → grid 行号：1-based 且 end 不含', () => {
  assert.deepEqual(sectionGridRow(1, 2), { rowStart: 1, rowEnd: 3 })
  assert.deepEqual(sectionGridRow(5, 2), { rowStart: 5, rowEnd: 7 })
})

test('节次时间标签取默认表（与广州大学作息一致）', () => {
  assert.equal(DEFAULT_SECTION_TIMES.length, 12)
  assert.equal(sectionTimeLabel(DEFAULT_SECTION_TIMES, 1), '08:30–09:15')
  assert.equal(sectionTimeLabel(DEFAULT_SECTION_TIMES, 3), '10:25–11:10')
  assert.equal(sectionTimeLabel(DEFAULT_SECTION_TIMES, 99), '')
})

test('minutesOfDay：解析 HH:MM，非法值给 NaN（不当成 0 点）', () => {
  assert.equal(minutesOfDay('08:30'), 510)
  assert.equal(minutesOfDay('00:00'), 0)
  assert.ok(Number.isNaN(minutesOfDay('25:00')))
  assert.ok(Number.isNaN(minutesOfDay('abc')))
})

test('今天的课：按星期 + 周次过滤，按开始时间排序', () => {
  const semester = { semesterStart: new Date(2026, 7, 30), totalWeeks: 19 }
  const courses = [
    course({ id: 'a', weekday: 4, startSection: 3, sectionCount: 2, weeks: [] }),   // 每周
    course({ id: 'b', weekday: 4, startSection: 5, sectionCount: 2, weeks: [11] }), // 第 11 周
    course({ id: 'c', weekday: 4, startSection: 1, sectionCount: 2, weeks: [1] }),  // 第 1 周，不该出现
    course({ id: 'd', weekday: 2, startSection: 3, sectionCount: 2, weeks: [] }),   // 周二，不是这天
  ]
  const entries = coursesOnDate(courses, new Date(2026, 10, 12), semester, DEFAULT_SECTION_TIMES) // 2026-11-12 周四
  assert.deepEqual(entries.map((e) => e.course.id), ['a', 'b'])
  assert.equal(entries[0].timeLabel, '10:25–12:00')
  assert.equal(entries[0].sectionLabel, '第 3-4 节')
})

test('今天的课：未开学（早于学期起始）返回空数组，不猜', () => {
  const semester = { semesterStart: new Date(2026, 7, 30), totalWeeks: 19 }
  const entries = coursesOnDate([course({ weekday: 4, weeks: [] })], new Date(2026, 7, 20), semester, DEFAULT_SECTION_TIMES)
  assert.deepEqual(entries, [])
})

test('正在上的课与下一节：互不混用（下一节不指向正在上的那节）', () => {
  const semester = { semesterStart: new Date(2026, 7, 30), totalWeeks: 19 }
  const entries = coursesOnDate(
    [course({ id: 'a', weekday: 4, startSection: 3, weeks: [] }), course({ id: 'b', weekday: 4, startSection: 5, weeks: [] })],
    new Date(2026, 10, 12),
    semester,
    DEFAULT_SECTION_TIMES,
  )
  // 11:00 = 660：a 在 10:25–12:00 之间（正在上），b 在 13:50 才开始
  assert.equal(ongoingCourse(entries, 660)?.course.id, 'a')
  assert.equal(nextCourse(entries, 660)?.course.id, 'b')
  // 09:00 = 540：a 还没开始，它就是下一节
  assert.equal(ongoingCourse(entries, 540), null)
  assert.equal(nextCourse(entries, 540)?.course.id, 'a')
  // 21:00 = 1260：今天没课了
  assert.equal(nextCourse(entries, 1260), null)
})

test('倒计时文案：分钟 / 小时 / 已开始', () => {
  assert.equal(formatRemaining(35), '35 分钟')
  assert.equal(formatRemaining(60), '1 小时')
  assert.equal(formatRemaining(65), '1 小时 05 分')
  assert.equal(formatRemaining(0), '即将开始')
  assert.equal(formatRemaining(-5), '即将开始')
})
