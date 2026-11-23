# 课表应用 · 开发约定

## 规则表

| 规则 | 由什么拦住 |
|---|---|
| 交差前跑通测试并附真浏览器截图 | `tests/test_cross_page_dedupe.py`、`tests/verify_pdf_import.mjs`、`tests/verify_clear_and_buttons.mjs`、`tests/verify_multi_table.mjs`、`tests/verify_topbar_import.mjs` |
| 多课表：每张学期独立 config/courses/view，切换只换 activeId；旧数据从 schedule.v1 迁移 | `tests/verify_multi_table.mjs`（迁移/隔离/新建/删除/改名）；`web/app.js` 的 store 模型 |
| 禁用原生 alert/confirm（预览面板 iframe 会吞掉，导致按钮"点了没反应"） | `tests/verify_clear_and_buttons.mjs`（把原生 confirm stub 成抛错仍能通过）；`web/app.js` 的 `showToast`/`askConfirm` |
| 静态文件必须 no-store（否则预览面板缓存旧 HTML，新按钮看不到） | `ocr_server.py` 的 `end_headers()`；测试 URL 带版本号 |
| PDF/JSON 导入必须替换旧课程，不能追加（否则同一门课显示多份） | `tests/verify_pdf_import.mjs` 场景2「预置旧数据后替换不叠加」；`web/app.js` 的 `commitPdfImport` 默认 replace |
| 跨页重印行要去重（源 PDF 把同一大节在页尾/页首各印一次） | `tests/test_cross_page_dedupe.py`（离线回放真实返回） |
| 定位星期/节次用 ColTl/RowTl 索引，不用 Polygon 坐标（长表坐标失效） | 上面两个测试周三恰好 2 门的断言 |

## 改动后必做

- 改了识别映射 → 跑 `python tests/test_cross_page_dedupe.py`（离线、不耗腾讯云额度）。
- 改了前端导入/渲染 → 跑 `node tests/verify_pdf_import.mjs`（真浏览器、需先起 8080 服务，会消耗少量 OCR 额度）。
- 截图存 `tests/screenshots/`，交差时引用。
- 提交被大小钩子拒了 → 照报错把文件按功能拆成几个再提交，别绕过钩子。
- 写新函数、新规则前 → 先搜项目里有没有现成的，有就复用，不另起一份。

## 密钥

- 腾讯云密钥只在 `.env`（已 gitignore），不进代码、不进对话。
