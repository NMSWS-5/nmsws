"""离线回归测试：验证跨页重印行去重 + 课表映射（不调用腾讯云、不消耗额度）。

运行：python tests/test_cross_page_dedupe.py
依赖：tests/raw_page1.json、tests/raw_page2.json（从腾讯云真实返回 dump）
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "tools"))
import ocr_server as S  # noqa: E402


def process(pages):
    """复刻 do_POST 的处理链路，输入页码列表，输出最终课程。"""
    all_courses, seen, counter, prev_keys = [], set(), 0, None
    dropped = []
    for page in pages:
        with open(os.path.join(HERE, "raw_page%d.json" % page), encoding="utf-8") as f:
            result = json.load(f)
        courses, _ = S.tables_to_courses(result, section_offset=counter)
        by_sec = {}
        for c in courses:
            by_sec.setdefault(c.get("start"), []).append(c)
        if by_sec and prev_keys:
            first = min(by_sec)
            keys = {(c["day"], c["name"], c["week"]) for c in by_sec[first]}
            overlap = len(keys & prev_keys)
            if overlap >= max(3, int(len(prev_keys) * 0.6)):
                dropped.append((page, first, overlap))
                courses = [c for c in courses if c.get("start") != first]
                by_sec.pop(first, None)
        if by_sec:
            prev_keys = {
                (c["day"], c["name"], c["week"])
                for c in by_sec[max(by_sec)]
            }
        for c in courses:
            sec = c.get("start")
            key = (c["day"], sec, c["name"], c["week"])
            if key in seen:
                continue
            seen.add(key)
            all_courses.append(c)
    used = sorted(set(c["start"] for c in all_courses))
    remap = {old: i + 1 for i, old in enumerate(used)}
    for c in all_courses:
        c["start"] = remap[c["start"]]
        c["end"] = c["start"]
    return S.dedupe_courses(all_courses), used, dropped


def main():
    courses, sections, dropped = process([1, 2])

    checks = [
        ("跨页重印行被丢弃", dropped == [(2, 4, 5)], dropped),
        ("节次压缩为 3 节", len(sections) == 3, sections),
        ("总课程数为 14", len(courses) == 14, len(courses)),
        (
            "周三只有 2 门，无重复 Web 框架",
            [c["name"] for c in sorted(
                (c for c in courses if c["day"] == 3),
                key=lambda x: x["start"],
            )] == ["习近平新时代中国特色社会主义思想概论", "Web框架技术及实验"],
            [(c["start"], c["name"]) for c in courses if c["day"] == 3],
        ),
        (
            "各门课都是 1..3 节",
            all(1 <= c["start"] <= 3 for c in courses),
            [(c["name"], c["start"]) for c in courses],
        ),
        (
            "无重复(星期,节次,课程名)",
            len({(c["day"], c["start"], c["name"]) for c in courses}) == len(courses),
            len(courses),
        ),
    ]
    failed = 0
    for name, ok, detail in checks:
        print("%s %s" % ("PASS" if ok else "FAIL", name))
        if not ok:
            failed += 1
            print("       实际:", detail)
    print("\n%d/%d 通过" % (len(checks) - failed, len(checks)))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
