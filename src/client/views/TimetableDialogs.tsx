/**
 * 课表的两个弹窗：**课程编辑**与**学期设置**。
 *
 * 与 `views/` 的其它文件同一套边界：只渲染、只发意图，不持有 state、不发 HTTP。
 * 表单形状（`CourseDraft`）的所有者是 `hooks/useTimetable.ts`，这里只 `patch` 它。
 *
 * ## 交互口径
 * - 新建与编辑**共用同一个弹窗**（字段一致），但标题与主按钮文案区分 ——
 *   用户点了空白格却看到"编辑课程"会以为点错了。
 * - 删除在编辑弹窗里，**两段式**：先点「删除」露出确认行，再点「确定删除」。
 *   课表里一门课可能连着好几周的课表视图，误删的代价比多点一次大。
 * - Esc / 遮罩 / 取消都走 `onClose`，与项目里其它弹窗一致。
 */
import { useState } from 'react'
import { Modal } from '../components/Modal.js'
import { Icon } from '../components/Icon.js'
import { WEEKDAY_LABELS, TIMETABLE_SECTION_COUNT } from '../courseGrid.js'
import type { CourseDraft } from '../hooks/useTimetable.js'
import type { Task, TimetableSettings } from '../viewTypes.js'

export type TimetableDialogsProps = {
  editor: CourseDraft | null
  settingsOpen: boolean
  settings: TimetableSettings
  busy: boolean
  /** 全部任务（用于在课程弹窗里列出「这门课的任务」；按 `courseId` 过滤）。 */
  tasks: readonly Task[]
  /** 点任务行 → 打开任务详情（装配层的 `openTaskById`）。 */
  onOpenTask: (taskId: string) => void
  onPatchEditor: (patch: Partial<CourseDraft>) => void
  onSaveEditor: () => void
  onCloseEditor: () => void
  onRemoveCourse: (id: string) => void
  onCloseSettings: () => void
  onSaveSettings: (input: { semesterStart: string; totalWeeks: number; sectionTimes: TimetableSettings['sectionTimes'] }) => void
}

/** 课程编辑/新建弹窗。 */
export function CourseEditorModal({ editor, busy, tasks, onOpenTask, onPatchEditor, onSaveEditor, onCloseEditor, onRemoveCourse }: TimetableDialogsProps): JSX.Element | null {
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  if (editor === null) return null
  const isNew = editor.id === null
  /**
   * 这门课下的任务（schema 21 的 `courseId`）。
   *
   * 过滤放在这里而不是由父级算好：它只是"按一个字段筛数组"，没有判定口径，
   * 不存在第二份实现的风险；真正有口径的是"什么算这门课"，那是 DB 里的外键。
   */
  const related = isNew ? [] : tasks.filter((task) => task.courseId === editor.id && !task.archived)
  return (
    <Modal
      title={<><Icon name={isNew ? 'plus' : 'edit'} />{isNew ? '新建课程' : '编辑课程'}</>}
      size="md"
      onClose={onCloseEditor}
      footer={(
        <>
          {!isNew && (
            confirmingDelete
              ? <>
                  <button className="wb-btn" style={{ color: '#e74c3c', borderColor: '#e74c3c' }} disabled={busy} onClick={() => onRemoveCourse(editor.id!)}>确定删除</button>
                  <button className="wb-btn" onClick={() => setConfirmingDelete(false)}>再想想</button>
                </>
              : <button className="wb-btn" disabled={busy} onClick={() => setConfirmingDelete(true)}>删除</button>
          )}
          <div style={{ flex: 1 }} />
          <button className="wb-btn" onClick={onCloseEditor}>{'取消'}</button>
          <button className="wb-btn primary" disabled={busy || editor.name.trim() === ''} onClick={onSaveEditor}>
            <Icon name="check" />{isNew ? '添加' : '保存'}
          </button>
        </>
      )}
    >
      <div className="wb-form" style={{ border: 'none', padding: 0 }}>
        <label className="full">{'课程名'}<input autoFocus data-autofocus value={editor.name} placeholder="如：高等数学I1" onChange={(e) => onPatchEditor({ name: e.target.value })} /></label>
        <label>{'上课地点'}<input value={editor.location} placeholder="如：文新511（阶）" onChange={(e) => onPatchEditor({ location: e.target.value })} /></label>
        <label>{'任课教师'}<input value={editor.teacher} placeholder="如：袁荣" onChange={(e) => onPatchEditor({ teacher: e.target.value })} /></label>
        <label>{'星期'}<select value={editor.weekday} onChange={(e) => onPatchEditor({ weekday: Number(e.target.value) })}>{WEEKDAY_LABELS.map((label, index) => <option key={label} value={index}>{label}</option>)}</select></label>
        <label>{'开始节次'}<select value={editor.startSection} onChange={(e) => onPatchEditor({ startSection: Number(e.target.value) })}>{Array.from({ length: TIMETABLE_SECTION_COUNT }, (_, i) => i + 1).map((n) => <option key={n} value={n}>第 {n} 节</option>)}</select></label>
        <label>{'连续节数'}<select value={editor.sectionCount} onChange={(e) => onPatchEditor({ sectionCount: Number(e.target.value) })}>{Array.from({ length: 8 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n} 节</option>)}</select></label>
        <label>{'颜色'}<input type="color" value={editor.color === '' ? '#4f8ef7' : editor.color} onChange={(e) => onPatchEditor({ color: e.target.value })} /></label>
        <label className="full">
          {'上课周次'}
          <input value={editor.weeksText} placeholder="留空 = 每周；可填 1-16 或 1,3,5-8 或 1-16单" onChange={(e) => onPatchEditor({ weeksText: e.target.value })} />
        </label>
        <p className="wb-hint" style={{ gridColumn: '1 / -1', margin: 0 }}>
          留空表示整学期每周都上。要单双周就写「1-16单」或「1-16双」。
        </p>
        <label className="full">{'备注'}<textarea rows={2} value={editor.note} onChange={(e) => onPatchEditor({ note: e.target.value })} /></label>
      </div>
      {/**
        * 这门课的任务（schema 21 的结构化关联）。
        *
        * 新建时不渲染（还没有 id，不可能有关联）。空态给一句"怎么挂上去"，
        * 而不是留一块空白 —— 否则用户不知道这个区域为什么存在。
        */}
      {!isNew && (
        <div className="wb-course-tasks">
          <div className="wb-course-tasks-head">这门课的任务（{related.length}）</div>
          {related.length === 0
            ? <div className="wb-hint" style={{ margin: 0 }}>还没有挂到这门课的任务。新建或编辑任务时，在「所属课程」里选它即可。</div>
            : related.map((task) => (
                <button key={task.id} className="wb-course-task" onClick={() => onOpenTask(task.id)} title="打开任务详情">
                  <span className="wb-course-task-title">{task.title}</span>
                  <span className="wb-course-task-meta">
                    {task.statusCode === 'done' ? '已完成' : task.dueAt !== null ? task.dueAt.slice(5, 16).replace('T', ' ') : '无截止'}
                  </span>
                </button>
              ))}
        </div>
      )}
    </Modal>
  )
}

/** 学期设置弹窗：学期起始（第一周的周日）、总周数、每节起止时间。 */
export function TimetableSettingsModal({ settingsOpen, settings, busy, onCloseSettings, onSaveSettings }: TimetableDialogsProps): JSX.Element | null {
  const [semesterStart, setSemesterStart] = useState(settings.semesterStart)
  const [totalWeeks, setTotalWeeks] = useState(String(settings.totalWeeks))
  const [sections, setSections] = useState(settings.sectionTimes.map((item) => ({ ...item })))
  const [error, setError] = useState<string | null>(null)
  if (!settingsOpen) return null

  const patchSection = (index: number, patch: Partial<{ start: string; end: string }>): void => {
    setSections((previous) => previous.map((item) => (item.index === index ? { ...item, ...patch } : item)))
  }

  return (
    <Modal
      title={<><Icon name="settings" />{'课表设置'}</>}
      size="md"
      onClose={onCloseSettings}
      footer={(
        <>
          <button className="wb-btn" onClick={onCloseSettings}>{'取消'}</button>
          <button
            className="wb-btn primary"
            disabled={busy}
            onClick={() => {
              const weeks = Number(totalWeeks)
              if (!Number.isInteger(weeks) || weeks < 1 || weeks > 60) { setError('学期总周数必须是 1–60 的整数'); return }
              setError(null)
              onSaveSettings({ semesterStart, totalWeeks: weeks, sectionTimes: sections })
            }}
          >
            <Icon name="check" />{'保存'}
          </button>
        </>
      )}
    >
      {error !== null && <div className="wb-banner error" style={{ marginBottom: 10 }}>{error}</div>}
      <div className="wb-form" style={{ border: 'none', padding: 0 }}>
        <label>{'学期起始日'}<input type="date" value={semesterStart} onChange={(e) => setSemesterStart(e.target.value)} /></label>
        <label>{'学期总周数'}<input type="number" min={1} max={60} value={totalWeeks} onChange={(e) => setTotalWeeks(e.target.value)} /></label>
        <p className="wb-hint" style={{ gridColumn: '1 / -1', margin: 0 }}>
          起始日填**第一周所在的周日**（课表以周日为第一列）。填错会让「第几周」整体偏移。
        </p>
      </div>
      <div className="wb-tt-section-form">
        <div className="wb-tt-section-form-head">{'每节起止时间'}</div>
        <div className="wb-tt-section-form-grid">
          {sections.map((item) => (
            <div key={item.index} className="wb-tt-section-form-row">
              <span className="wb-tt-section-form-no">第 {item.index} 节</span>
              <input type="time" value={item.start} onChange={(e) => patchSection(item.index, { start: e.target.value })} />
              <span>–</span>
              <input type="time" value={item.end} onChange={(e) => patchSection(item.index, { end: e.target.value })} />
            </div>
          ))}
        </div>
      </div>
    </Modal>
  )
}
