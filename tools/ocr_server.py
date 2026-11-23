#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
课表 PDF -> JSON 本地转换服务（方案 A：腾讯云表格识别 V3）

职责：
  1. 托管 web/ 静态文件（替代 python -m http.server）
  2. POST /api/ocr ：收 PDF（base64 或原始 bytes），逐页调腾讯云
     RecognizeTableAccurateOCR，把表格单元格坐标还原成课表 JSON

密钥：只从环境变量或项目根的 .env 读取，绝不写死在代码里。
  TENCENTCLOUD_SECRET_ID=xxx
  TENCENTCLOUD_SECRET_KEY=yyy

依赖：仅 Python 标准库（urllib / hmac / hashlib / json），无需 pip install。
"""

import base64
import datetime
import hashlib
import hmac
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = ROOT / "web"
ENV_FILE = ROOT / ".env"

HOST = "ocr.tencentcloudapi.com"
ENDPOINT = "https://" + HOST
ACTION = "RecognizeTableAccurateOCR"
VERSION = "2018-11-19"
SERVICE = "ocr"
REGION = os.environ.get("TENCENTCLOUD_REGION", "ap-guangzhou")
PORT = int(os.environ.get("PORT", "8080"))

DAY_MAP = {
    "星期一": 1, "星期二": 2, "星期三": 3, "星期四": 4,
    "星期五": 5, "星期六": 6, "星期日": 7, "星期天": 7,
    "周一": 1, "周二": 2, "周三": 3, "周四": 4,
    "周五": 5, "周六": 6, "周日": 7, "周天": 7,
}
DAY_NAMES_FULL = {"星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日", "星期天"}
CN_SECTION = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5,
              "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}


def load_credentials():
    """环境变量优先，其次项目根 .env。返回 (secret_id, secret_key)。"""
    sid = os.environ.get("TENCENTCLOUD_SECRET_ID", "").strip()
    skey = os.environ.get("TENCENTCLOUD_SECRET_KEY", "").strip()
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k, v = k.strip(), v.strip().strip('"').strip("'")
            if k == "TENCENTCLOUD_SECRET_ID" and not sid:
                sid = v
            elif k == "TENCENTCLOUD_SECRET_KEY" and not skey:
                skey = v
    return sid, skey


def sha256_hex(msg: bytes) -> str:
    return hashlib.sha256(msg).hexdigest()


def tc3_sign(payload: dict, secret_id: str, secret_key: str, timestamp: int):
    """腾讯云 API 3.0 TC3-HMAC-SHA256 签名，返回 Authorization 头。"""
    date = datetime.datetime.fromtimestamp(timestamp, datetime.timezone.utc).strftime("%Y-%m-%d")
    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    payload_hash = sha256_hex(body)

    canonical_headers = "content-type:application/json; charset=utf-8\nhost:%s\n" % HOST
    signed_headers = "content-type;host"
    hashed_request = sha256_hex((
        "POST\n/\n\n" + canonical_headers + "\n" + signed_headers + "\n" + payload_hash
    ).encode("utf-8"))
    credential_scope = "%s/%s/tc3_request" % (date, SERVICE)
    string_to_sign = "\n".join(["TC3-HMAC-SHA256", str(timestamp), credential_scope, hashed_request])

    secret_date = hmac.new(("TC3" + secret_key).encode("utf-8"), date.encode("utf-8"), hashlib.sha256).digest()
    secret_service = hmac.new(secret_date, SERVICE.encode("utf-8"), hashlib.sha256).digest()
    secret_signing = hmac.new(secret_service, b"tc3_request", hashlib.sha256).digest()
    signature = hmac.new(secret_signing, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()

    authorization = (
        "TC3-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s"
        % (secret_id, credential_scope, signed_headers, signature)
    )
    return authorization, body


def call_tencent(payload: dict, secret_id: str, secret_key: str):
    timestamp = int(time.time())
    authorization, body = tc3_sign(payload, secret_id, secret_key, timestamp)
    req = urllib.request.Request(ENDPOINT + "/", data=body, method="POST")
    req.add_header("Authorization", authorization)
    req.add_header("Content-Type", "application/json; charset=utf-8")
    req.add_header("Host", HOST)
    req.add_header("X-TC-Action", ACTION)
    req.add_header("X-TC-Timestamp", str(timestamp))
    req.add_header("X-TC-Version", VERSION)
    req.add_header("X-TC-Region", REGION)
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        raise RuntimeError("腾讯云 HTTP %s: %s" % (e.code, detail[:400]))
    except urllib.error.URLError as e:
        raise RuntimeError("无法连接腾讯云：%s" % e.reason)
    if "Response" not in data:
        raise RuntimeError("腾讯云返回格式异常：%s" % json.dumps(data, ensure_ascii=False)[:300])
    result = data["Response"]
    if "Error" in result:
        err = result["Error"]
        raise RuntimeError("腾讯云错误 [%s] %s" % (err.get("Code", "?"), err.get("Message", "?")))
    return result


def normalize_text(s):
    if not s:
        return ""
    s = s.replace("\u3000", " ").replace("\r", "\n")
    return re.sub(r"[ \t]+", " ", s).strip()


def cell_bbox(cell):
    pts = cell.get("Polygon") or []
    if not pts:
        return None
    xs = [float(p.get("X", 0)) for p in pts]
    ys = [float(p.get("Y", 0)) for p in pts]
    if not xs or not ys:
        return None
    return min(xs), min(ys), max(xs), max(ys)


def parse_week(text):
    """从单元格文字里抽周次，返回 app 需要的字符串形式。"""
    m = re.search(r"(\d{1,2})\s*[-~—至到]\s*(\d{1,2})\s*周", text)
    if m:
        return "%s-%s" % (int(m.group(1)), int(m.group(2)))
    m = re.search(r"第?\s*(\d{1,2})\s*周", text)
    if m:
        return str(int(m.group(1)))
    if "单周" in text:
        return "odd"
    if "双周" in text:
        return "even"
    return "all"


def parse_cell_text(text):
    """解析单个单元格文字 -> {name, teacher, location, week}。"""
    lines = [normalize_text(x) for x in (text or "").split("\n") if normalize_text(x)]
    if not lines:
        return None
    joined = "\n".join(lines)
    if not re.search(r"[\u4e00-\u9fa5A-Za-z]", joined):
        return None

    week = parse_week(joined)
    location = None
    lm = re.search(r"[A-Za-z]\s*\d\s*[-－]\s*\d{2,4}|[（(]?[^\s,，\n]{0,12}(?:楼|室|校区)[）)]?", joined)
    if lm:
        location = re.sub(r"\s+", "", lm.group(0))

    # 老师名：课表格式固定为「课程名+老师名(2-4汉字)+【周次】」，
    # 老师名紧贴在【之前。用「课程名常用后缀」反向锚定边界：
    # 从【前一段的末尾往前找，切掉以课程后缀字（验/计/论/导/程/艺…）结尾的部分，
    # 剩下的 2-4 字才是老师名。
    teacher = None
    tm = re.search(r"([\u4e00-\u9fa5]{2,4})\s*[（(]?\s*(?:老师|讲师)", joined)
    if tm:
        teacher = tm.group(1)
    if not teacher:
        before_week = re.split(r"【", joined)[0].strip()
        # 去掉括号补充说明，如「专业日语（上）」->「专业日语」，便于切老师名
        before_week = re.sub(r"[（(][^）)]*[）)]", "", before_week).strip()
        # 尝试 2/3/4 字老师名：从末尾取候选，验证「前缀是课程名、以课程后缀字结尾」
        for tlen in (2, 3, 4):
            if len(before_week) <= tlen:
                continue
            cand = before_week[-tlen:]
            prefix = before_week[:-tlen]
            if not re.fullmatch(r"[\u4e00-\u9fa5]{2,4}", cand):
                continue
            if re.search(r"(课程|实验|设计|概论|指导|技术|英语|日语|体育|教学|实践|语言|框架|工程|及|与|上|下|及实验)", cand):
                continue
            # 前缀必须以课程名常见收尾字结束（验/计/论/导/程/式/艺/学…）
            if re.search(r"[验计论导程式艺学语统战基目划设践论概]$", prefix):
                teacher = cand
                break
        if not teacher:
            # 兜底：已知老师词表（这份课表 + 常见），从文本末尾精确匹配
            for known in ("段聪颖", "宋野", "宋辉", "吴琼", "张琪琪", "张琪瑶",
                          "郑云鹏", "李颖", "裴志松", "朱雨晴", "刘洋", "王磊"):
                if before_week.endswith(known):
                    teacher = known
                    break

    clean = joined
    clean = re.sub(r"[【(（]?\s*\d{1,2}\s*[-~—至到]\s*\d{1,2}\s*周\s*[】)）]?", "", clean)
    clean = re.sub(r"[【(（]?\s*第?\s*\d{1,2}\s*周\s*[】)）]?", "", clean)
    clean = re.sub(r"(?:单|双)周", "", clean)
    if location:
        clean = clean.replace(location, "")
    if teacher:
        clean = clean.replace(teacher, "")
    clean = re.sub(r"[\u4e00-\u9fa5]{2,4}\s*(?:老师|讲师)", "", clean)
    clean = re.sub(r"[，,、;；]", " ", clean)
    clean = re.sub(r"\s+", " ", clean).strip(" -–—\n")
    if not clean:
        return None
    return {"name": clean, "teacher": teacher or "", "location": location or "", "week": week}


def split_multi_course(text):
    """一个单元格里塞了两门课时拆开（如 Python 1-8周 / 操作系统 9-16周）。

    腾讯云用 `\\ldots` 或 '...' 连接同一格里的两段文字。
    """
    parts = re.split(r"\\ldots|\.\.\.|…|…", text or "")
    return [normalize_text(p) for p in parts if normalize_text(p)]


def tables_to_courses(api_result, section_offset=0):
    """把腾讯云表格识别结果还原成课程数组。

    样本课表的规律（已用原图核对）：
      - ColTl 即星期：c1=周一 … c7=周日；c0 是节次标签列
      - RowTl 是行索引：表头行=0；课程行是奇数行(1,3,5…)，偶数行是空白节次标签
      - 跨页时同一大节被切断：第1页末尾课程行 == 第2页顶部 R0 课程行，需去重
      - 节次标签(一/二/三/四/五)在 c0，但只有部分行有课
      - Polygon 坐标对这种长表格不可靠，一律以 ColTl/RowTl 为准

    section_offset: 跨页时上一页已占用的节次数，用于连续编号。
    返回 (courses, max_section)。
    """
    tables = api_result.get("TableDetections") or []
    courses = []
    max_section = 0
    for table in tables:
        cells = table.get("Cells") or []
        if not cells:
            continue
        # 收集所有行列索引 >= 0 的单元格（排除 -1 的页面标题）
        grid = {}
        for cell in cells:
            r, c = cell.get("RowTl"), cell.get("ColTl")
            if not isinstance(r, int) or not isinstance(c, int) or r < 0 or c < 0:
                continue
            grid.setdefault(r, {})[c] = normalize_text(cell.get("Text"))

        for r in sorted(grid):
            row = grid[r]
            # 表头行：c1~c7 里出现"星期X"或"日数"（不能用单字"一"判断，
            # 它和节次标签冲突）
            header_hit = any(
                v in ("日数",) or v.startswith("星期")
                for c, v in row.items() if c >= 1
            )
            # 也兼容纯"星期一"写法
            if not header_hit:
                header_hit = any(v in DAY_NAMES_FULL for c, v in row.items() if c >= 1)
            if header_hit:
                continue
            course_cells = {c: v for c, v in row.items() if c >= 1 and v}
            if not course_cells:
                continue

            # 该行是否为课程行：c1~c7 里有可解析的课程文字
            parsed_row = []
            for c in sorted(course_cells):
                day = c  # ColTl 1..7 => 周一..周日
                if day > 7:
                    continue
                for piece in split_multi_course(course_cells[c]):
                    parsed = parse_cell_text(piece)
                    if parsed:
                        parsed["day"] = day
                        parsed["color"] = "#4f86f7"
                        parsed["note"] = ""
                        parsed_row.append(parsed)
            if not parsed_row:
                continue

            # 行 -> 节次：用该行 c0 的节次标签（若有），否则按课程行序号顺延
            section = None
            label = row.get(0, "")
            if label in CN_SECTION:
                section = CN_SECTION[label]
            else:
                m = re.match(r"第?\s*(\d{1,2})\s*节", label)
                if m:
                    section = int(m.group(1))
            if section is None:
                section = section_offset + 1
            for c in parsed_row:
                c["start"] = section
                c["end"] = section
            max_section = max(max_section, section)
            courses.extend(parsed_row)
    return dedupe_courses(courses), max_section


def dedupe_courses(courses):
    seen = set()
    out = []
    for c in courses:
        key = (c.get("day"), c.get("start"), c.get("name"))
        if key in seen:
            continue
        seen.add(key)
        out.append(c)
    return out


def build_payload(pdf_b64: str, page: int) -> dict:
    return {
        "ImageBase64": pdf_b64,
        "PdfPageNumber": page,
        "UseNewModel": True,
    }


def pdf_page_count(data: bytes) -> int:
    head = data[:200000]
    n = len(re.findall(rb"/Type\s*/Page[^s]", head))
    return max(1, n)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        # 静态资源禁缓存：预览面板 iframe 会缓存旧 HTML/JS，导致新按钮/修复看不到
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
        super().end_headers()

    def do_GET(self):
        if self.path.split("?")[0] == "/api/health":
            sid, skey = load_credentials()
            self._json(200, {"ok": True, "credentials_configured": bool(sid and skey)})
            return
        super().do_GET()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_POST(self):
        if self.path.split("?")[0] != "/api/ocr":
            self._json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 30 * 1024 * 1024:
                raise RuntimeError("请求体为空或超过 30MB 限制")
            req_data = json.loads(self.rfile.read(length).decode("utf-8"))
            pdf_b64 = req_data.get("pdfBase64", "")
            if not pdf_b64:
                raise RuntimeError("缺少 pdfBase64")
            if "," in pdf_b64 and pdf_b64.strip().startswith("data:"):
                pdf_b64 = pdf_b64.split(",", 1)[1]
            try:
                raw = base64.b64decode(pdf_b64, validate=True)
            except Exception:
                raise RuntimeError("pdfBase64 解码失败")

            sid, skey = load_credentials()
            if not sid or not skey:
                self._json(503, {
                    "error": "尚未配置腾讯云密钥。请在项目根建 .env 写入 "
                             "TENCENTCLOUD_SECRET_ID 和 TENCENTCLOUD_SECRET_KEY，"
                             "或设成系统环境变量后重启服务。",
                    "configured": False,
                })
                return

            pages = req_data.get("pages")
            if not pages:
                pages = list(range(1, pdf_page_count(raw) + 1))
            pages = [int(p) for p in pages if int(p) >= 1]
            if not pages:
                pages = [1]

            all_courses = []
            raw_pages = []
            seen_sections = set()
            section_counter = 0
            prev_row_keys = None  # 上一页最后一个节次行的 (星期,课程名,周次) 集合
            for page in pages:
                result = call_tencent(build_payload(pdf_b64, page), sid, skey)
                courses, _ = tables_to_courses(result, section_offset=section_counter)
                # 跨页去重：源 PDF 会把同一个大节在页尾和页首各印一次，
                # 两页节次号不同（如 3 和 4），按单门课判重会漏掉。
                # 改为比较「整行课程集合」：若本页首行与上页末行高度重合，
                # 判定为跨页重印，整行丢弃。
                by_section = {}
                for c in courses:
                    by_section.setdefault(c.get("start"), []).append(c)
                if by_section and prev_row_keys:
                    first_sec = min(by_section)
                    first_keys = {
                        (c["day"], c["name"], c["week"])
                        for c in by_section[first_sec]
                    }
                    overlap = len(first_keys & prev_row_keys)
                    threshold = max(3, int(len(prev_row_keys) * 0.6))
                    if overlap >= threshold:
                        courses = [
                            c for c in courses if c.get("start") != first_sec
                        ]
                        by_section.pop(first_sec, None)
                        raw_pages.append({
                            "page": page,
                            "dropped_duplicate_row": True,
                            "overlap": overlap,
                        })
                if by_section:
                    last_sec = max(by_section)
                    prev_row_keys = {
                        (c["day"], c["name"], c["week"])
                        for c in by_section[last_sec]
                    }
                # 为无标签的行编号；按单门课判重作为兜底
                new_courses = []
                page_sections = set()
                for c in courses:
                    # 节次标签若来自 c0（一/二/三/四/五），直接使用；
                    # 否则用递增编号
                    sec = c.get("start")
                    if not isinstance(sec, int) or sec < 1:
                        section_counter += 1
                        sec = section_counter
                        for x in courses:
                            if x is c or x.get("start") == c.get("start"):
                                x["start"] = sec
                                x["end"] = sec
                    c["start"] = sec
                    c["end"] = sec
                    key = (c["day"], sec, c["name"], c["week"])
                    if key in seen_sections:
                        continue
                    seen_sections.add(key)
                    page_sections.add(sec)
                    new_courses.append(c)
                section_counter = max([section_counter] + list(page_sections))
                all_courses.extend(new_courses)
                raw_pages.append({
                    "page": page,
                    "tables": len(result.get("TableDetections") or []),
                    "courses": len(new_courses),
                    "sections": sorted(page_sections),
                })
            # 重新压缩节次为 1..N（跨页去重后可能有空缺）
            used = sorted(set(c["start"] for c in all_courses))
            remap = {old: i + 1 for i, old in enumerate(used)}
            for c in all_courses:
                c["start"] = remap[c["start"]]
                c["end"] = c["start"]
            self._json(200, {
                "ok": True,
                "courses": dedupe_courses(all_courses),
                "pages": raw_pages,
                "sections": len(used),
                "note": "识别结果请核对星期/节次/周次/教师名后再导入。",
            })
        except Exception as e:
            self._json(500, {"error": str(e), "ok": False})

    def log_message(self, fmt, *args):
        sys.stderr.write("[ocr_server] " + (fmt % args) + "\n")


def main():
    sid, skey = load_credentials()
    state = "密钥已配置" if (sid and skey) else "密钥未配置（PDF 转换会返回 503，页面可正常打开）"
    print("课表转换服务启动: http://127.0.0.1:%d/" % PORT)
    print("静态目录: %s" % WEB_DIR)
    print("腾讯云: %s / %s" % (state, REGION))
    print("按 Ctrl+C 停止")
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
        server.server_close()


if __name__ == "__main__":
    main()
