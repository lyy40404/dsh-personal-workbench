/**
 * 课表视图（D 系列：一比一复刻企业微信课表）。
 *
 * 参照的界面（用户提供的截图，广州大学教务课表查询）：
 * - 表头两行：周几 + 日期；**周日在最左**；
 * - 左侧节次列 1…12，每格标节号与起止时间；
 * - 课程块跨节合并、实色底白字，内容是「课名 / 地点 / 教师」三行居中；
 * - 顶部切周。
 *
 * ## 边界（本项目的硬规矩）
 * - **不发 HTTP**：课程数据、任务都是 props；写操作走注入回调。
 * - **不做业务判定**：周次换算、撞课分列、颜色全在 `client/courseGrid.ts`（纯函数，可单测）。
 * - 组件只负责把已算好的 `placed` 画到网格上。
 *
 * ## 交互口径（"合乎人类常规"的三条）
 * 1. 点**课程块** = 看详情（去编辑），不是直接删；删除在详情里二次确认。
 * 2. 点**空白格** = 在这天这一节新建，星期与起始节次已预填（不用再选一遍）。
 * 3. 点**日期表头** = 切到那一天的日期面板（任务、计划都在那里），不在课表里重复造一份列表。
 */
import { useMemo } from 'react'
import type { Course, Task } from '../viewTypes.js'
import {
  WEEKDAY_LABELS, courseColor, dateOfWeekday, dayCoursesFor, sectionTimeLabel, weekStartFor,
  type SectionTime,
} from '../courseGrid.js'
import { isTaskDueOnDay } from '../taskFilterSort.js'
import { localDateString, sameDay } from '../format.js'

export type TimetableViewProps = {
  courses: Course[]
  /** 当前显示第几周（1-based）。 */
  weekNumber: number
  totalWeeks: number
  /** 学期第一周的周日。 */
  semesterStart: Date
  sectionTimes: readonly SectionTime[]
  /** 渲染期的"现在"（今天高亮用）。 */
  now: Date
  tasks: Task[]
  onMoveWeek: (delta: number) => void
  onToday: () => void
  onOpenSettings: () => void
  onOpenCourse: (course: Course) => void
  /** 点空白格：新建一门课，星期与起始节次已给定。 */
  onNewCourse: (weekday: number, startSection: number) => void
  /** 点日期表头：去那一天的日期面板。 */
  onPickDay: (day: string) => void
}

export function TimetableView(props: TimetableViewProps): JSX.Element {
  const { courses, weekNumber, totalWeeks, semesterStart, sectionTimes, now, tasks, onMoveWeek, onToday, onOpenSettings, onOpenCourse, onNewCourse, onPickDay } = props

  const weekStart = useMemo(() => weekStartFor(semesterStart, weekNumber) ?? semesterStart, [semesterStart, weekNumber])
  const weekDays = useMemo(
    () => Array.from({ length: 7 }, (_, index) => dateOfWeekday(weekStart, index)),
    [weekStart],
  )
  /** 每一天的课（已按周次过滤、已按撞课分列）。 */
  const placedByDay = useMemo(
    () => weekDays.map((_, weekday) => dayCoursesFor(courses, weekday, weekNumber)),
    [courses, weekNumber, weekDays],
  )
  /**
   * 每一天的任务数（课表上的**任务标注**）。
   *
   * 口径复用 `isTaskDueOnDay`（与日历/日期面板同一个判定，不另写一份），
   * 已取消的任务不算 —— 与日期面板看到的一致。
   */
  const taskCountByDay = useMemo(
    () => weekDays.map((date) => tasks.filter((task) => isTaskDueOnDay(task, date)).length),
    [tasks, weekDays],
  )

  const rowCount = sectionTimes.length
  const containsToday = weekDays.some((date) => sameDay(date, now))
  const todayIndex = weekDays.findIndex((date) => sameDay(date, now))

  return (
    <>
      <div className="wb-cal-nav">
        <button className="wb-btn" onClick={() => onMoveWeek(-1)} disabled={weekNumber <= 1} title="上一周">◀</button>
        <button className="wb-btn" onClick={onToday}>本周</button>
        <button className="wb-btn" onClick={() => onMoveWeek(1)} disabled={weekNumber >= totalWeeks} title="下一周">▶</button>
        <div className="wb-tt-title">
          <span className="wb-tt-week-no">第 {weekNumber} 周</span>
          <span className="wb-tt-week-range">
            {weekDays[0].getMonth() + 1}/{weekDays[0].getDate()} – {weekDays[6].getMonth() + 1}/{weekDays[6].getDate()}
          </span>
        </div>
        <button className="wb-btn" onClick={onOpenSettings} title="学期与节次设置">课表设置</button>
      </div>

      <div className="wb-tt-scroll">
        <div
          className="wb-tt-grid"
          style={{ gridTemplateRows: `38px 26px repeat(${rowCount}, var(--wb-tt-row-h, 66px))` }}
        >
          {/* ---- 表头 ---- */}
          <div className="wb-tt-corner" style={{ gridColumn: 1, gridRow: '1 / span 2' }} aria-hidden />
          {weekDays.map((date, weekday) => {
            const isToday = sameDay(date, now)
            const count = taskCountByDay[weekday]
            return (
              <button
                key={`head-${weekday}`}
                className={`wb-tt-head${isToday ? ' today' : ''}`}
                style={{ gridColumn: weekday + 2, gridRow: '1 / span 2' }}
                onClick={() => onPickDay(localDateString(date))}
                title={`${WEEKDAY_LABELS[weekday]} ${localDateString(date)}${count > 0 ? ` · ${count} 项任务` : ''}`}
              >
                <span className="wb-tt-weekday">{WEEKDAY_LABELS[weekday]}</span>
                <span className="wb-tt-date">
                  {date.getMonth() + 1}-{String(date.getDate()).padStart(2, '0')}
                  {/* 任务标注：当天到期条数（点表头去当天的日期面板看明细） */}
                  {count > 0 && <span className="wb-tt-taskdot">{count}</span>}
                </span>
              </button>
            )
          })}

          {/* ---- 节次标签列 + 空白格（点空格 = 新建） ---- */}
          {Array.from({ length: rowCount }, (_, index) => index + 1).map((section) => {
            // 节次列放宽到 58px 后，起止时间按两行排（一行 10px 的 "08:30–09:15" 会溢出）
            const [from, to] = sectionTimeLabel(sectionTimes, section).split('–')
            return (
              <div key={`sec-${section}`} className="wb-tt-section" style={{ gridColumn: 1, gridRow: section + 2 }}>
                <span className="wb-tt-section-no">{section}</span>
                <span className="wb-tt-section-time">{from}{to !== undefined && to !== '' ? <><br />{to}</> : null}</span>
              </div>
            )
          })}
          {weekDays.map((_, weekday) => Array.from({ length: rowCount }, (_, index) => index + 1).map((section) => (
            <button
              key={`cell-${weekday}-${section}`}
              className={`wb-tt-cell${weekday === todayIndex ? ' today' : ''}`}
              style={{ gridColumn: weekday + 2, gridRow: section + 2 }}
              onClick={() => onNewCourse(weekday, section)}
              title={`${WEEKDAY_LABELS[weekday]} 第 ${section} 节 · 点击新建`}
              aria-label={`在${WEEKDAY_LABELS[weekday]}第 ${section} 节新建课程`}
            />
          )))}

          {/* ---- 课程块（跨节合并；撞课时按 column 并排） ---- */}
          {placedByDay.map((placed, weekday) => placed.map(({ course, column, columnCount }) => {
            const background = course.color ?? courseColor(course.name)
            const widthPct = 100 / columnCount
            return (
              <div
                key={`slot-${course.id}`}
                className="wb-tt-slot"
                style={{ gridColumn: weekday + 2, gridRow: `${course.startSection + 2} / span ${course.sectionCount}` }}
              >
                <button
                  className="wb-tt-course"
                  style={{
                    background,
                    left: `calc(${column * widthPct}% + 2px)`,
                    width: `calc(${widthPct}% - 4px)`,
                  }}
                  onClick={() => onOpenCourse(course)}
                  title={`${course.name}${course.location !== '' ? ` · ${course.location}` : ''}${course.teacher !== '' ? ` · ${course.teacher}` : ''}`}
                >
                  <span className="wb-tt-course-name">{course.name}</span>
                  {course.location !== '' && <span className="wb-tt-course-meta">{course.location}</span>}
                  {course.teacher !== '' && <span className="wb-tt-course-meta">{course.teacher}</span>}
                </button>
              </div>
            )
          }))}
        </div>
      </div>

      {/* 空课表的引导：不在网格里塞占位文本，那是"假数据" */}
      {courses.length === 0 && (
        <div className="wb-tt-empty">还没有课程。点任意空白格新建，或在「课表设置」里先填学期起始周。</div>
      )}
      <div className="wb-tt-hint">
        {containsToday ? '' : `当前显示第 ${weekNumber} 周（不是本周）。`}
        点课程块可编辑，点空白格新建，点日期表头去当天的任务与计划。
      </div>
    </>
  )
}
