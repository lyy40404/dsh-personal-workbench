/**
 * 课表域（schema 20）：课程列表、周次游标、课程编辑草稿、学期设置的**全部状态与请求**。
 *
 * 边界（与 `useIdeas` 同一套）：
 * - 只依赖 `api` 与共享类型；不 import 组件、不 import 入口。
 * - 周次换算、撞课分列、周次文本解析都在 `client/courseGrid.ts`（纯函数，可单测），
 *   这里只负责"什么时候发请求、发什么"。
 * - 表单是**草稿**形状：`id === null` = 新建。保存成功才刷新列表，失败把原因抛给调用方
 *   （`setError` 由入口注入，本文件不猜怎么展示）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import { DEFAULT_SECTION_TIMES, DEFAULT_TOTAL_WEEKS, formatWeeks, parseWeeksInput, weekNumberFor } from '../courseGrid.js'
import type { Course, TimetableSettings } from '../viewTypes.js'

/** 课程编辑/新建表单（`id === null` = 新建）。 */
export interface CourseDraft {
  id: string | null
  name: string
  teacher: string
  location: string
  weekday: number
  startSection: number
  sectionCount: number
  /** 用户输入的周次原文（"1-16" / "1,3,5-8" / 空 = 每周）。 */
  weeksText: string
  /** '#RRGGBB' 或 ''（自动着色）。 */
  color: string
  note: string
}

export type UseTimetableInput = {
  /** 视图门控：只有 `timetable` 视图才拉取课程与设置。 */
  activeView: string
  /** 渲染期的"现在"（算当前第几周）。 */
  now: Date
  setError: (message: string | null) => void
  setNotice: (message: string | null) => void
}

export type UseTimetableResult = {
  courses: Course[]
  settings: TimetableSettings
  /** 当前显示第几周（1-based）。 */
  weekNumber: number
  loading: boolean
  /** 课程新建/编辑表单（null = 没在编辑）。 */
  editor: CourseDraft | null
  /** 学期设置弹窗是否打开。 */
  settingsOpen: boolean
  actions: {
    reload: () => Promise<void>
    moveWeek: (delta: number) => void
    goToday: () => void
    openNew: (weekday: number, startSection: number) => void
    openEdit: (course: Course) => void
    closeEditor: () => void
    patchEditor: (patch: Partial<CourseDraft>) => void
    saveEditor: () => Promise<void>
    removeCourse: (id: string) => Promise<void>
    openSettings: () => void
    closeSettings: () => void
    saveSettings: (input: { semesterStart: string; totalWeeks: number; sectionTimes: TimetableSettings['sectionTimes'] }) => Promise<void>
  }
}

/** 设置缺省值（第一次打开、服务端没存过时用它，与 shared/timetable.ts 同源）。 */
function defaultSettings(now: Date): TimetableSettings {
  const sunday = new Date(now)
  sunday.setHours(0, 0, 0, 0)
  sunday.setDate(sunday.getDate() - sunday.getDay())
  const key = `${sunday.getFullYear()}-${String(sunday.getMonth() + 1).padStart(2, '0')}-${String(sunday.getDate()).padStart(2, '0')}`
  return { semesterStart: key, totalWeeks: DEFAULT_TOTAL_WEEKS, sectionTimes: [...DEFAULT_SECTION_TIMES] }
}

/** 'YYYY-MM-DD' → 本地 Date（不经过 UTC，避免时区把周日挪到周六）。 */
export function parseDateKey(key: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
  if (match === null) return new Date()
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isNaN(date.getTime()) ? new Date() : date
}

export function useTimetable(input: UseTimetableInput): UseTimetableResult {
  const { activeView, now, setError, setNotice } = input
  const [courses, setCourses] = useState<Course[]>([])
  const [settings, setSettings] = useState<TimetableSettings>(() => defaultSettings(now))
  const [loading, setLoading] = useState(false)
  const [editor, setEditor] = useState<CourseDraft | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  /**
   * 周次游标。`null` = 跟随"今天所在的那一周"（打开页面、设置变化后自动落回本周）；
   * 用户点了 ◀ ▶ 之后才固定下来。这样"改了学期起始日，课表不会还停在旧周次"。
   */
  const [weekCursor, setWeekCursor] = useState<number | null>(null)

  const semesterStart = useMemo(() => parseDateKey(settings.semesterStart), [settings.semesterStart])
  const todayWeek = useMemo(() => weekNumberFor(semesterStart, now) ?? 1, [semesterStart, now])
  const weekNumber = useMemo(() => {
    const candidate = weekCursor ?? todayWeek
    return Math.min(Math.max(candidate, 1), Math.max(settings.totalWeeks, 1))
  }, [weekCursor, todayWeek, settings.totalWeeks])

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const [list, config] = await Promise.all([
        api<{ ok: boolean; courses: Course[] }>('/api/workbench/courses'),
        api<{ ok: boolean; settings: TimetableSettings }>('/api/workbench/courses/settings'),
      ])
      setCourses(Array.isArray(list.courses) ? list.courses : [])
      if (config.settings !== undefined && config.settings !== null) setSettings(config.settings)
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [setError])

  useEffect(() => {
    if (activeView !== 'timetable') return
    void reload()
  }, [activeView, reload])

  const moveWeek = useCallback((delta: number): void => {
    setWeekCursor((previous) => {
      const base = previous ?? todayWeek
      return Math.min(Math.max(base + delta, 1), Math.max(settings.totalWeeks, 1))
    })
  }, [todayWeek, settings.totalWeeks])

  const goToday = useCallback((): void => { setWeekCursor(null) }, [])

  const openNew = useCallback((weekday: number, startSection: number): void => {
    setEditor({ id: null, name: '', teacher: '', location: '', weekday, startSection, sectionCount: 2, weeksText: '', color: '', note: '' })
  }, [])

  const openEdit = useCallback((course: Course): void => {
    setEditor({
      id: course.id,
      name: course.name,
      teacher: course.teacher,
      location: course.location,
      weekday: course.weekday,
      startSection: course.startSection,
      sectionCount: course.sectionCount,
      weeksText: formatWeeks(course.weeks) === '每周' ? '' : formatWeeks(course.weeks),
      color: course.color ?? '',
      note: course.note,
    })
  }, [])

  const closeEditor = useCallback((): void => { setEditor(null) }, [])

  const patchEditor = useCallback((patch: Partial<CourseDraft>): void => {
    setEditor((previous) => (previous === null ? previous : { ...previous, ...patch }))
  }, [])

  const saveEditor = useCallback(async (): Promise<void> => {
    if (editor === null) return
    try {
      const weeks = parseWeeksInput(editor.weeksText)
      const payload = {
        name: editor.name.trim(),
        teacher: editor.teacher.trim(),
        location: editor.location.trim(),
        weekday: editor.weekday,
        startSection: editor.startSection,
        sectionCount: editor.sectionCount,
        weeks,
        color: editor.color.trim() === '' ? null : editor.color.trim(),
        note: editor.note,
      }
      if (payload.name === '') throw new Error('课程名不能为空')
      if (editor.id === null) {
        await api('/api/workbench/courses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
        setNotice('已添加课程')
      } else {
        await api(`/api/workbench/courses/${encodeURIComponent(editor.id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
        setNotice('已保存课程')
      }
      setEditor(null)
      await reload()
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    }
  }, [editor, reload, setError, setNotice])

  const removeCourse = useCallback(async (id: string): Promise<void> => {
    try {
      await api(`/api/workbench/courses/${encodeURIComponent(id)}`, { method: 'DELETE' })
      setNotice('已删除课程')
      setEditor(null)
      await reload()
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    }
  }, [reload, setError, setNotice])

  const openSettings = useCallback((): void => { setSettingsOpen(true) }, [])
  const closeSettings = useCallback((): void => { setSettingsOpen(false) }, [])

  const saveSettings = useCallback(async (next: { semesterStart: string; totalWeeks: number; sectionTimes: TimetableSettings['sectionTimes'] }): Promise<void> => {
    try {
      const response = await api<{ ok: boolean; settings: TimetableSettings }>('/api/workbench/courses/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(next),
      })
      if (response.settings !== undefined && response.settings !== null) setSettings(response.settings)
      setWeekCursor(null)
      setSettingsOpen(false)
      setNotice('已保存课表设置')
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    }
  }, [setError, setNotice])

  return {
    courses,
    settings,
    weekNumber,
    loading,
    editor,
    settingsOpen,
    actions: { reload, moveWeek, goToday, openNew, openEdit, closeEditor, patchEditor, saveEditor, removeCourse, openSettings, closeSettings, saveSettings },
  }
}
