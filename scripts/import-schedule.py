"""Import only 全部日程; the date-specific sheets repeat the same source rows.

Requires openpyxl. Run from any directory: python scripts/import-schedule.py
IDs are 52-bit hashes of source business identity, never row positions or sort order.
Missing source text stays empty except the explicitly displayed missing-speaker notice.
"""

import argparse
from collections import Counter
from datetime import date
import hashlib
import json
from pathlib import Path
import re
import shutil

import openpyxl

ROOT = Path(__file__).resolve().parents[1]
SOURCE_NAME = "2026神经病学年会日程.xlsx"
HEADERS = ("日期", "星期", "会场", "主题", "小节时间", "小节名称", "主持", "编号", "时间", "类型", "题目", "讲者", "单位")
TIME_RANGE = re.compile(r"(\d{2}):(\d{2})-(\d{2}):(\d{2})")


def text(value):
    return "" if value is None else str(value)


def interval(value, row_number, field):
    match = TIME_RANGE.fullmatch(value)
    if not match:
        raise ValueError(f"源行 {row_number} {field} 无有效时间段: {value!r}")
    sh, sm, eh, em = map(int, match.groups())
    if not (0 <= sh < 24 and 0 <= eh < 24 and 0 <= sm < 60 and 0 <= em < 60):
        raise ValueError(f"源行 {row_number} {field} 时间越界: {value}")
    start, end = sh * 60 + sm, eh * 60 + em
    if end <= start:
        raise ValueError(f"源行 {row_number} {field} 结束时间必须晚于开始时间: {value}")
    return start, end


def import_schedule(source):
    workbook = openpyxl.load_workbook(source, read_only=True, data_only=True)
    try:
        sheet = workbook["全部日程"]
        source_rows = sheet.iter_rows(values_only=True)
        headers = tuple(next(source_rows))
        if headers != HEADERS:
            raise ValueError(f"全部日程表头与预期不符: {headers!r}")
        records, identities, bounds, warnings = [], {}, [], []
        for row_number, values in enumerate(source_rows, start=2):
            if all(value is None for value in values):
                raise ValueError(f"源行 {row_number} 为空；拒绝静默跳过日程")
            row = dict(zip(HEADERS, map(text, values)))
            day = row["日期"]
            try:
                parsed_day = date.fromisoformat(day)
            except ValueError as error:
                raise ValueError(f"源行 {row_number} 日期无效: {day!r}") from error
            if parsed_day.isoformat() != day:
                raise ValueError(f"源行 {row_number} 日期必须为 YYYY-MM-DD: {day!r}")
            expected_weekday = "星期" + "一二三四五六日"[parsed_day.weekday()]
            if row["星期"] != expected_weekday:
                raise ValueError(f"源行 {row_number} 星期与日期不符: {row['星期']!r}")
            session_start, session_end = interval(row["小节时间"], row_number, "小节时间")
            event_time = row["时间"] or row["小节时间"]
            start, end = interval(event_time, row_number, "时间")
            if start < session_start or end > session_end:
                warnings.append(f"源行 {row_number}: 单项时间 {event_time} 超出小节 {row['小节时间']}，忠实保留源值")
            if not row["小节名称"] or not row["会场"]:
                raise ValueError(f"源行 {row_number} 缺少小节名称或会场")
            # Use source business fields, not derived display values or source row numbers.
            identity = json.dumps([row[key] for key in ("日期", "会场", "主题", "小节时间", "小节名称", "编号", "时间", "类型", "题目", "讲者")], ensure_ascii=False, separators=(",", ":"))
            stable_id = int(hashlib.sha256(identity.encode("utf-8")).hexdigest()[:13], 16)
            if stable_id in identities:
                raise ValueError(f"源行 {row_number} 与源行 {identities[stable_id]} 的业务标识重复或 ID 哈希碰撞；拒绝导入")
            identities[stable_id] = row_number
            period = "上午" if start < 12 * 60 else "下午" if start < 18 * 60 else "晚上"
            records.append({
                "id": stable_id,
                "kind": row["类型"],
                # The workbook has no category column; all rows belong to its main schedule.
                "scheduleCategory": "主日程",
                "program": row["主题"],
                "session": row["小节名称"],
                "abstractNo": row["编号"],
                "sourceTitle": row["题目"] or row["小节名称"],
                "speaker": row["讲者"] or "日程未提供",
                "institution": row["单位"] or "日程未提供",
                "dateTime": f"{day} {period} {event_time}",
                "location": row["会场"],
                "field": row["主题"] or row["小节名称"],
                "directions": [row["类型"]] if row["类型"] else [],
                "chairman": row["主持"],
                "sourceRow": row_number,
                "sessionTime": row["小节时间"],
            })
            bounds.append((start, end))
        if not records:
            raise ValueError("全部日程没有可导入记录")
        return records, bounds, warnings
    finally:
        workbook.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ROOT / SOURCE_NAME)
    args = parser.parse_args()
    records, bounds, warnings = import_schedule(args.source)
    destination = ROOT / "app" / "data" / "schedule.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(records, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    public_source = ROOT / "public" / "data" / SOURCE_NAME
    public_source.parent.mkdir(parents=True, exist_ok=True)
    if args.source.resolve() != public_source.resolve():
        shutil.copyfile(args.source, public_source)
    print(json.dumps({
        "rows": len(records),
        "days": dict(sorted(Counter(record["dateTime"][:10] for record in records).items())),
        "firstMinute": min(start for start, _ in bounds),
        "lastMinute": max(end for _, end in bounds),
        "missingSpeakers": sum(record["speaker"] == "日程未提供" for record in records),
        "missingKinds": sum(not record["kind"] for record in records),
        "warnings": warnings,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
