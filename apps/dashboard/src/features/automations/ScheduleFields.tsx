import { ChoiceField, DateField, TimeField } from "./SchedulePickers";
import { Temporal } from "@js-temporal/polyfill";
import { calendarFrequency, changeScheduleMode, frequencies, newScheduleDraft, weekdays, weekdayNames } from "./form";
import type { Frequency, ScheduleDraft, ScheduleMode } from "./form";

const modes: [ScheduleMode, string][] = [["once", "仅执行一次"], ["interval", "固定间隔"], ["daily", "每天"],
  ["weekdays", "每周一至周五"], ["weekly", "每周"], ["monthly", "每月"], ["yearly", "每年"], ["custom", "自定义"]];

export function ScheduleFields({ value, zone, onChange }: {
  value: ScheduleDraft; zone: string; onChange(value: ScheduleDraft): void;
}) {
  const update = (patch: Partial<ScheduleDraft>) => onChange({ ...value, ...patch });
  const calendar = !["once", "interval", "preserved"].includes(value.mode);
  const frequency = calendar ? calendarFrequency(value) : "daily";
  const maxDay = frequency === "yearly" ? Temporal.PlainDate.from({ year: 2000, month: value.month, day: 1 }).daysInMonth : 31;
  return <fieldset className="automation-schedule">
    <legend className="automation-sr-only">时间安排</legend>
    {value.mode === "preserved" ? <div className="automation-preserved-schedule">
      <p>保留已保存的自定义计划</p>
      <small>此计划包含当前表单无法完整编辑的时间条件。修改任务内容时会保留原时间安排，也可以先预览接下来的执行时间。</small>
      <span className="automation-muted">时区：{zone}</span>
      <button type="button" onClick={() => onChange(newScheduleDraft(zone))}>重新设置时间</button>
    </div> : <>
      <div className="automation-schedule-row"><span>重复</span><ChoiceField name="schedule" label="重复" value={value.mode} options={modes} onChange={mode => onChange(changeScheduleMode(value, mode as ScheduleMode, zone))}/></div>
      {value.mode === "custom" && <>
        <label className="automation-schedule-row"><span>重复周期</span><select name="frequency" value={value.frequency} onChange={event => update({ frequency: event.target.value as Frequency })}>
          <option value="daily">按天</option><option value="weekly">按周</option><option value="monthly">按月</option><option value="yearly">按年</option>
        </select></label>
        <label className="automation-schedule-row"><span>每隔</span><span className="automation-schedule-interval"><input name="every" type="number" min={1} max={999} step={1} required value={value.every || ""} onChange={event => update({ every: Number(event.target.value) })}/><span>{frequencies[value.frequency]}</span></span></label>
      </>}
      {value.mode === "interval" && <label className="automation-schedule-row"><span>每隔</span><span className="automation-schedule-interval"><input name="minutes" type="number" min={1} max={525600} step={1} required value={value.minutes || ""} onChange={event => update({ minutes: Number(event.target.value) })}/><span>分钟</span></span></label>}
      {calendar && frequency === "weekly" && value.mode !== "weekdays" && <fieldset className="automation-weekdays">
        <legend>执行日</legend><div>{weekdays.map((day, index) => <label key={day}>
          <input type="checkbox" name="weekdays" value={day} checked={value.weekdays.includes(day)} required={index === 0 && value.weekdays.length === 0}
            onChange={event => update({ weekdays: event.target.checked ? [...value.weekdays, day] : value.weekdays.filter(item => item !== day) })}/>{weekdayNames[day]}
        </label>)}</div>
      </fieldset>}
      {calendar && frequency === "yearly" && <label className="automation-schedule-row"><span>月份</span><select name="month" value={value.month} onChange={event => update({ month: Number(event.target.value) })}>
        {Array.from({ length: 12 }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1} 月</option>)}
      </select></label>}
      {calendar && ["monthly", "yearly"].includes(frequency) && <label className="automation-schedule-row"><span>日期</span><span className="automation-schedule-interval"><input name="monthDay" type="number" min={1} max={maxDay} step={1} required value={value.monthDay || ""} onChange={event => update({ monthDay: Number(event.target.value) })}/><span>日</span></span></label>}
      {value.mode === "once" && <>
        <div className="automation-schedule-row"><span>日期</span><DateField name="onceDate" label="执行日期" value={value.onceAt.split("T")[0]} onChange={date => update({ onceAt: `${date}T${value.onceAt.split("T")[1] || "09:00"}` })}/></div>
        <div className="automation-schedule-row"><span>时间</span><TimeField name="onceTime" label="执行时间" value={value.onceAt.split("T")[1] || "09:00"} onChange={time => update({ onceAt: `${value.onceAt.split("T")[0]}T${time}` })}/></div>
      </>}
      {calendar && <>
        <div className="automation-schedule-row"><span>时间</span><TimeField name="time" label="执行时间" value={value.time} onChange={time => update({ time })}/></div>

      </>}
      {calendar && frequency === "monthly" && value.monthDay > 28 && <small>没有此日期的月份会跳过。</small>}
      {calendar && frequency === "yearly" && value.month === 2 && value.monthDay === 29 && <small>只在有 2 月 29 日的年份执行。</small>}

    </>}
  </fieldset>;
}

export function ScheduleAdvanced({ value, zone, onChange, onZoneChange }: {
  value: ScheduleDraft; zone: string; onChange(value: ScheduleDraft): void; onZoneChange(zone: string): void;
}) {
  if (value.mode === "preserved") return null;
  return <>
    {!["once", "interval"].includes(value.mode) && <div className="automation-schedule-row"><span>开始日期</span><DateField name="startDate" label="开始日期" value={value.startDate} onChange={startDate => onChange({ ...value, startDate })}/></div>}
    <label className="automation-schedule-row"><span>时区</span><input name="timezone" required value={zone} onChange={event => onZoneChange(event.target.value)} placeholder="Asia/Shanghai"/></label>
  </>;
}
