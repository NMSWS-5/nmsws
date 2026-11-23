(function () {
  'use strict';

  // ============ 数据模型（可拓展） ============
  // store: { tables:[ {id, name, config, courses, view} ], activeId }
  //   config: { version, term, classMode, sections, days, dayLabels[], sectionTimes[],
  //             totalWeeks, semesterStart }
  //   course: { id, name, teacher, location, color, day(1-7), start, end,
  //             week('all'|'odd'|'even'|数字), note }
  //   view: { currentWeek }
  // 每张课表（学期）独立保存 config/courses/view；切换=换 activeId。
  // 拓展点：week 支持单双周与具体周；可加 remind 提醒字段；
  //        可加 importFromCloud() 实现网页版<->小程序版同步（共用同一 JSON 结构）。

  var STORAGE_KEY = 'schedule.v2';
  var LEGACY_KEY = 'schedule.v1';
  var DAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

  function fmtMin(m) {
    var h = Math.floor(m / 60), mm = m % 60;
    return (h < 10 ? '0' : '') + h + ':' + (mm < 10 ? '0' : '') + mm;
  }
  // 默认时间表（校历规则）：每大节 = 两小节(45分钟/小节) + 大节内休息10分钟 = 100分钟；
  // 大课（大节）之间休息 20 分钟；当天 17:10 收工，不排晚课。
  function genDefaultTimes(n) {
    var classMin = 45;
    var bigStarts = [8 * 60, 10 * 60, 13 * 60 + 30, 15 * 60 + 30];
    var arr = [];
    for (var i = 0; i < n; i++) {
      var bigIdx = Math.floor(i / 2);
      var small = i % 2;
      var start;
      if (bigIdx < 4) {
        var bs = bigStarts[bigIdx];
        start = small === 0 ? bs : bs + (classMin + 10);
      } else {
        start = 19 * 60 + (i - 8) * (classMin + 10);
      }
      arr.push(fmtMin(start) + '–' + fmtMin(start + classMin));
    }
    return arr;
  }
  // 大节模式时间表：4 大节，每大节 100 分钟，大节之间休息 20 分钟，17:10 收工
  function genBigTimes() {
    var bigStarts = [8 * 60, 10 * 60, 13 * 60 + 30, 15 * 60 + 30];
    return bigStarts.map(function (bs) { return fmtMin(bs) + '–' + fmtMin(bs + 100); });
  }
  // 从大节时间(如 "08:00–09:40") 拆出所含两小节时间
  function deriveSmallTimes(big) {
    var m = /^(\d{1,2}):(\d{2})\s*[–-]\s*(\d{1,2}):(\d{2})$/.exec(big || '');
    if (!m) return ['', ''];
    var start = (+m[1]) * 60 + (+m[2]);
    return [fmtMin(start) + '–' + fmtMin(start + 45), fmtMin(start + 55) + '–' + fmtMin(start + 100)];
  }
  function defaultConfig() {
    var cfg = {
      version: 1, term: '2026 秋季学期', classMode: 'big', sections: 4, days: 7,
      dayLabels: DAY_LABELS.slice(), totalWeeks: 20, semesterStart: ''
    };
    cfg.sectionTimes = genBigTimes();
    return cfg;
  }

  // ===== 应用内提示/确认：预览面板 iframe 会拦截原生 alert/confirm，一律不用原生弹窗 =====
  var toastEl = document.getElementById('toast');
  var toastTimer = null;
  function showToast(msg, ms) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.add('hidden'); }, ms || 2600);
  }
  var confirmBox = document.getElementById('confirmBox');
  var confirmResolve = null;
  function askConfirm(msg, title) {
    return new Promise(function (resolve) {
      if (!confirmBox) return resolve(window.confirm ? window.confirm(msg) : false);
      document.getElementById('confirmTitle').textContent = title || '请确认';
      document.getElementById('confirmMsg').textContent = msg;
      confirmBox.classList.remove('hidden');
      confirmResolve = resolve;
    });
  }
  function closeConfirm(result) {
    if (confirmBox) confirmBox.classList.add('hidden');
    var r = confirmResolve; confirmResolve = null;
    if (r) r(result);
  }
  document.getElementById('confirmYes').addEventListener('click', function () { closeConfirm(true); });
  document.getElementById('confirmNo').addEventListener('click', function () { closeConfirm(false); });

  var config = defaultConfig();
  var courses = [];
  var currentWeek = 1;
  var draggedCourse = null;
  var dragOrigin = null;     // 拖动起点 { week, day, start }
  var edgeTimer = null;      // 边缘停留切换周的计时器
  var suppressClick = false; // 滑动后抑制误触发的 click

  // ===== 多课表状态 =====
  var store = { tables: [], activeId: null };
  function newId() { return 't' + Date.now() + Math.floor(Math.random() * 1000); }
  function normalizeTable(t) {
    var cfg = Object.assign(defaultConfig(), t.config || {});
    if (typeof cfg.totalWeeks !== 'number' || cfg.totalWeeks < 1) cfg.totalWeeks = 20;
    if (!Array.isArray(cfg.sectionTimes) || cfg.sectionTimes.length !== cfg.sections) {
      cfg.sectionTimes = (cfg.classMode === 'big')
        ? (cfg.sections <= 4 ? genBigTimes() : genDefaultTimes(cfg.sections))
        : genDefaultTimes(cfg.sections);
    }
    var cs = Array.isArray(t.courses) ? t.courses.map(function (c) {
      if (c.week == null) c.week = (c.weeks || 'all'); // 兼容旧字段
      return c;
    }) : [];
    var wk = (t.view && typeof t.view.currentWeek === 'number') ? t.view.currentWeek : 1;
    wk = Math.min(Math.max(wk, 1), cfg.totalWeeks);
    return {
      id: t.id || newId(),
      name: t.name || cfg.term || '我的课表',
      config: cfg, courses: cs, view: { currentWeek: wk }
    };
  }
  function makeEmptyTable(name) {
    return normalizeTable({ id: newId(), name: name || '新课表', config: defaultConfig(), courses: [], view: { currentWeek: 1 } });
  }
  function activeTable() {
    for (var i = 0; i < store.tables.length; i++) {
      if (store.tables[i].id === store.activeId) return store.tables[i];
    }
    return null;
  }
  function pullActiveIntoView() {
    var t = activeTable();
    if (!t) return;
    config = t.config; courses = t.courses; currentWeek = t.view.currentWeek;
  }
  function pushViewIntoActive() {
    var t = activeTable();
    if (!t) return;
    t.config = config; t.courses = courses; t.view = { currentWeek: currentWeek };
  }
  function persist() { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); }

  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var data = JSON.parse(raw);
        if (data && Array.isArray(data.tables) && data.tables.length) {
          store.tables = data.tables.map(normalizeTable);
          store.activeId = data.activeId;
          if (!activeTable()) store.activeId = store.tables[0].id;
        }
      } else {
        // 首次：迁移旧的单课表数据（schedule.v1）为第一张表
        var legacyRaw = localStorage.getItem(LEGACY_KEY);
        var first;
        if (legacyRaw) {
          try {
            var old = JSON.parse(legacyRaw);
            first = normalizeTable({ id: newId(), name: (old.config && old.config.term) || '2026 秋季学期',
              config: old.config || {}, courses: old.courses || [], view: old.view || {} });
          } catch (e) { first = null; }
        }
        if (!first) first = normalizeTable({ id: newId(), name: '2026 秋季学期', config: defaultConfig(), courses: [], view: { currentWeek: 1 } });
        store.tables = [first];
        store.activeId = first.id;
        persist();
      }
    } catch (e) {
      console.error('读取本地数据失败', e);
      if (!store.tables.length) { var t = makeEmptyTable('2026 秋季学期'); store.tables = [t]; store.activeId = t.id; }
    }
    pullActiveIntoView();
  }
  function save() {
    pushViewIntoActive();
    persist();
  }

  // 课程是否出现在指定周（支持：'all'|'odd'|'even'|数字|'a-b'范围|数字数组）
  function weekMatches(weekVal, cur) {
    if (weekVal == null || weekVal === 'all') return true;
    if (weekVal === 'odd') return cur % 2 === 1;
    if (weekVal === 'even') return cur % 2 === 0;
    if (typeof weekVal === 'number') return weekVal === cur;
    if (Array.isArray(weekVal)) return weekVal.indexOf(cur) >= 0;
    if (typeof weekVal === 'string') {
      if (weekVal.indexOf('-') >= 0) {
        var p = weekVal.split('-');
        return cur >= (+p[0]) && cur <= (+p[1]);
      }
      if (weekVal.indexOf(',') >= 0) {
        return weekVal.split(',').map(Number).indexOf(cur) >= 0;
      }
    }
    return false;
  }
  // 把用户输入/解析出的周次统一成可存储形式
  function parseWeekInput(v) {
    v = (v == null ? '' : String(v)).trim().replace(/，/g, ',');
    if (!v) return 'all';
    if (v === 'all' || v === 'odd' || v === 'even') return v;
    if (v.indexOf('-') >= 0) {
      var p = v.split('-');
      if (p.length === 2 && +p[0] && +p[1]) return (+p[0]) + '-' + (+p[1]);
    }
    if (v.indexOf(',') >= 0) {
      var arr = v.split(',').map(function (x) { return +x; }).filter(function (x) { return x; });
      if (arr.length) return arr;
    }
    var n = +v;
    return n ? n : 'all';
  }

  // ============ 日期辅助 ============
  function parseDate(s) { if (!s) return null; var p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function addDays(d, n) { var x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }
  function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }

  // ============ 渲染 ============
  var grid = document.getElementById('grid');
  var tableBtn = document.getElementById('tableBtn');
  var tableBtnName = document.getElementById('tableBtnName');
  var tableMenu = document.getElementById('tableMenu');
  var tableSwitcher = document.querySelector('.table-switcher');

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m];
    });
  }
  function th(t) { var e = document.createElement('th'); e.textContent = t; return e; }
  function cnNum(n) {
    var m = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
    if (n >= 1 && n <= 10) return m[n];
    return String(n);
  }

  function updateWeekBar() {
    document.getElementById('weekLabel').textContent = '第 ' + currentWeek + ' 周';
    document.getElementById('weekSub').textContent = '共 ' + config.totalWeeks + ' 周';
    document.getElementById('prevWeek').disabled = currentWeek <= 1;
    document.getElementById('nextWeek').disabled = currentWeek >= config.totalWeeks;
  }
  function goWeek(w) {
    w = Math.min(Math.max(w, 1), config.totalWeeks);
    if (w !== currentWeek) { currentWeek = w; save(); render(); }
  }

  function render() {
    tableBtnName.textContent = (activeTable() && activeTable().name) || config.term || '我的课表';
    grid.innerHTML = '';
    grid.classList.toggle('bigmode', config.classMode === 'big');
    updateWeekBar();

    var baseMonday = config.semesterStart ? addDays(parseDate(config.semesterStart), (currentWeek - 1) * 7) : null;

    // 表头
    var thead = document.createElement('tr');
    var corner = document.createElement('th');
    if (baseMonday) corner.textContent = (baseMonday.getMonth() + 1) + '月';
    thead.appendChild(corner);
    for (var d = 1; d <= config.days; d++) {
      var wd = document.createElement('th');
      var lbl = document.createElement('div'); lbl.className = 'wd-label';
      lbl.textContent = config.dayLabels[d - 1] || DAY_LABELS[d - 1];
      wd.appendChild(lbl);
      if (baseMonday) {
        var dt = addDays(baseMonday, d - 1);
        var dl = document.createElement('div'); dl.className = 'wd-date';
        dl.textContent = (dt.getMonth() + 1) + '/' + dt.getDate();
        if (sameDay(dt, new Date())) dl.classList.add('today');
        wd.appendChild(dl);
      }
      thead.appendChild(wd);
    }
    grid.appendChild(thead);

    // 节次行
    for (var s = 1; s <= config.sections; s++) {
      var tr = document.createElement('tr');
      var secTh = document.createElement('th');
      secTh.className = 'sec-head' + (config.classMode === 'big' ? ' big' : '');
      if (config.classMode === 'big') {
        var nameDiv = document.createElement('div');
        nameDiv.className = 'sec-name';
        nameDiv.textContent = cnNum(s) + '节';
        secTh.appendChild(nameDiv);
        var subs = document.createElement('div');
        subs.className = 'sec-subs';
        deriveSmallTimes(config.sectionTimes ? config.sectionTimes[s - 1] : '').forEach(function (t) {
          if (!t) return;
          var sub = document.createElement('div');
          sub.className = 'sec-sub';
          sub.textContent = t;
          subs.appendChild(sub);
        });
        secTh.appendChild(subs);
      } else {
        secTh.textContent = '第' + s + '节';
        if (config.sectionTimes && config.sectionTimes[s - 1]) {
          var st2 = document.createElement('div');
          st2.className = 'sec-time';
          st2.textContent = config.sectionTimes[s - 1];
          secTh.appendChild(st2);
        }
      }
      tr.appendChild(secTh);
      for (var d2 = 0; d2 < config.days; d2++) {
        var td = document.createElement('td');
        td.className = 'cell';
        td.dataset.day = d2 + 1;
        td.dataset.section = s;
        (function (day, sec) {
          td.addEventListener('click', function () {
            if (suppressClick) { suppressClick = false; return; }
            openEditor(null, { day: day, start: sec, end: sec });
          });
          td.addEventListener('dragover', function (ev) {
            if (!draggedCourse) return;
            ev.preventDefault();
            ev.dataTransfer.dropEffect = 'move';
            td.classList.add('drag-over');
            var rect = grid.getBoundingClientRect();
            if (ev.clientX - rect.left < 45) startEdgeSwitch(-1);
            else if (rect.right - ev.clientX < 45) startEdgeSwitch(1);
            else clearEdgeTimer();
          });
          td.addEventListener('dragleave', function () { td.classList.remove('drag-over'); });
          td.addEventListener('drop', function (ev) {
            if (!draggedCourse) return;
            ev.preventDefault(); ev.stopPropagation();
            td.classList.remove('drag-over');
            moveCourseTo(draggedCourse, day, sec);
            draggedCourse = null; clearEdgeTimer();
          });
        })(d2 + 1, s);
        tr.appendChild(td);
      }
      grid.appendChild(tr);
    }
    // 仅渲染当前周可见的课程
    courses.filter(function (c) { return weekMatches(c.week, currentWeek); }).forEach(placeCourse);
    fitGridHeight();
  }

  // 课表高度铺满视口：按可用高度和节数算每行高度，写进 CSS 变量
  function fitGridHeight() {
    var headRow = grid && grid.querySelector('tr');
    if (!headRow || !config.sections) return;
    var main = document.querySelector('main');
    var topbar = document.querySelector('.topbar');
    var headH = headRow.getBoundingClientRect().height;
    var mainStyle = main ? getComputedStyle(main) : null;
    var padT = mainStyle ? parseFloat(mainStyle.paddingTop) : 0;
    var padB = mainStyle ? parseFloat(mainStyle.paddingBottom) : 0;
    var topH = topbar ? topbar.getBoundingClientRect().height : 0;
    var available = window.innerHeight - topH - padT - padB - headH - 2;
    var cellH = Math.floor(available / config.sections);
    cellH = Math.max(52, Math.min(cellH, 260));
    grid.style.setProperty('--cell-h', cellH + 'px');
  }

  function placeCourse(c) {
    var day = c.day;
    if (day < 1 || day > config.days) return;
    var start = c.start, end = c.end || c.start;
    var cell = grid.querySelector('td[data-day="' + day + '"][data-section="' + start + '"]');
    if (!cell) return;
    var block = document.createElement('div');
    block.className = 'course';
    block.style.background = c.color || '#4f86f7';
    block.draggable = true;
    block.innerHTML = '<div class="c-name">' + esc(c.name) + '</div>' +
      (c.location ? '<div class="c-sub">@' + esc(c.location) + '</div>' : '') +
      (c.teacher ? '<div class="c-sub">' + esc(c.teacher) + '</div>' : '');
    block.addEventListener('click', function (ev) { ev.stopPropagation(); openEditor(c); });
    block.addEventListener('dragstart', function (ev) {
      ev.stopPropagation();
      draggedCourse = c;
      dragOrigin = {
        week: (typeof c.week === 'number') ? c.week : currentWeek,
        day: c.day, start: c.start
      };
      ev.dataTransfer.effectAllowed = 'move';
      try { ev.dataTransfer.setData('text/plain', c.id); } catch (e) {}
    });
    block.addEventListener('dragend', function () { draggedCourse = null; clearEdgeTimer(); });
    var span = Math.max(1, end - start + 1);
    cell.rowSpan = span;
    cell.appendChild(block);
    for (var s = start + 1; s <= end; s++) {
      var hide = grid.querySelector('td[data-day="' + day + '"][data-section="' + s + '"]');
      if (hide) hide.style.display = 'none';
    }
  }

  // ============ 拖动换课 / 调休 / 跨周互换 ============
  function startEdgeSwitch(dir) {
    if (edgeTimer) return;
    if ((dir < 0 && currentWeek <= 1) || (dir > 0 && currentWeek >= config.totalWeeks)) return;
    edgeTimer = setTimeout(function () {
      edgeTimer = null;
      goWeek(currentWeek + dir); // 切换周后自动重渲染，拖动继续，落点即新周
    }, 550);
  }
  function clearEdgeTimer() { if (edgeTimer) { clearTimeout(edgeTimer); edgeTimer = null; } }

  function moveCourseTo(course, day, startSec) {
    var newWeek = currentWeek;
    var orig = dragOrigin || {
      week: (typeof course.week === 'number') ? course.week : currentWeek,
      day: course.day, start: course.start
    };
    // 目标周、目标格的占用者
    var occupant = courses.find(function (c) {
      return c !== course && weekMatches(c.week, newWeek) && c.day === day &&
        startSec >= c.start && startSec <= (c.end || c.start);
    });
    var span = Math.max(1, (course.end || course.start) - course.start + 1);
    // 放置被拖课程到新周
    course.day = day;
    course.start = startSec;
    course.end = startSec + span - 1;
    if (course.end > config.sections) { course.end = config.sections; course.start = Math.max(1, config.sections - span + 1); }
    course.week = newWeek;
    // 与占用者互换：占用者回到被拖课程的原始周/格
    if (occupant) {
      var oSpan = Math.max(1, (occupant.end || occupant.start) - occupant.start + 1);
      occupant.week = orig.week;
      occupant.day = orig.day;
      occupant.start = orig.start;
      occupant.end = orig.start + oSpan - 1;
      if (occupant.end > config.sections) { occupant.end = config.sections; occupant.start = Math.max(1, config.sections - oSpan + 1); }
    }
    save(); render();
  }

  // ============ 空白区域左右滑动切换周 ============
  var ptrX = 0, ptrY = 0, ptrActive = false, ptrSwiped = false;
  grid.addEventListener('pointerdown', function (e) {
    suppressClick = false;
    if (e.target.closest('.course')) return; // 课程拖动走原生 DnD
    ptrX = e.clientX; ptrY = e.clientY; ptrActive = true; ptrSwiped = false;
  });
  grid.addEventListener('pointermove', function (e) {
    if (!ptrActive || ptrSwiped) return;
    var dx = e.clientX - ptrX, dy = e.clientY - ptrY;
    if (Math.abs(dx) > 60 && Math.abs(dy) < 50) {
      goWeek(currentWeek + (dx < 0 ? 1 : -1));
      ptrSwiped = true; suppressClick = true;
    }
  });
  function endPtr() { ptrActive = false; }
  grid.addEventListener('pointerup', endPtr);
  grid.addEventListener('pointercancel', endPtr);

  // ============ 课程编辑弹窗 ============
  var editor = document.getElementById('editor');
  var form = document.getElementById('courseForm');
  var editorTitle = document.getElementById('editorTitle');
  var btnDelete = document.getElementById('btnDelete');
  var editingId = null;

  function buildWeekGrid() {
    var g = document.getElementById('wpGrid');
    g.innerHTML = '';
    for (var i = 1; i <= config.totalWeeks; i++) {
      (function (n) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'wp-num'; b.textContent = n; b.dataset.w = n;
        b.addEventListener('click', function () { setWeekVal(String(n)); });
        g.appendChild(b);
      })(i);
    }
  }
  function setWeekVal(v) {
    form.fWeeksCustom.value = '';
    document.getElementById('fWeeks').value = v;
    var chips = document.querySelectorAll('#weekPicker .wp-chip');
    for (var i = 0; i < chips.length; i++) chips[i].classList.toggle('active', chips[i].dataset.w === v);
    var nums = document.querySelectorAll('#weekPicker .wp-num');
    for (var j = 0; j < nums.length; j++) nums[j].classList.toggle('active', String(nums[j].dataset.w) === String(v));
  }

  function openEditor(course, prefill) {
    editingId = course ? course.id : null;
    editorTitle.textContent = course ? '编辑课程' : '添加课程';
    btnDelete.classList.toggle('hidden', !course);
    form.fName.value = course ? course.name : '';
    form.fTeacher.value = course ? (course.teacher || '') : '';
    form.fLocation.value = course ? (course.location || '') : '';
    form.fDay.value = course ? course.day : (prefill ? prefill.day : 1);
    form.fStart.value = course ? course.start : (prefill ? prefill.start : 1);
    form.fEnd.value = course ? (course.end || course.start) : (prefill ? prefill.end : 2);
    form.fColor.value = course ? (course.color || '#4f86f7') : '#4f86f7';
    form.fNote.value = course ? (course.note || '') : '';
    var wv = course ? course.week : 'all';
    if (typeof wv === 'string' || Array.isArray(wv)) { form.fWeeksCustom.value = String(wv); setWeekVal('all'); }
    else { form.fWeeksCustom.value = ''; setWeekVal(String(wv)); }
    editor.classList.remove('hidden');
  }
  function closeEditor() { editor.classList.add('hidden'); }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var start = parseInt(form.fStart.value, 10);
    var end = parseInt(form.fEnd.value, 10);
    if (isNaN(start) || isNaN(end) || start < 1 || end < start) { showToast('节次填写有误'); return; }
    var custom = form.fWeeksCustom.value.trim();
    var week;
    if (custom) {
      week = parseWeekInput(custom);
    } else {
      var wv = form.fWeeks.value;
      week = (wv === 'all' || wv === 'odd' || wv === 'even') ? wv : Number(wv);
    }
    var data = {
      name: form.fName.value.trim(),
      teacher: form.fTeacher.value.trim(),
      location: form.fLocation.value.trim(),
      day: parseInt(form.fDay.value, 10),
      start: start, end: end,
      week: week,
      color: form.fColor.value,
      note: form.fNote.value.trim()
    };
    if (!data.name) { showToast('请填写课程名称'); return; }
    if (editingId) {
      var i = courses.findIndex(function (c) { return c.id === editingId; });
      if (i >= 0) courses[i] = Object.assign(courses[i], data);
    } else {
      data.id = 'c' + Date.now() + Math.floor(Math.random() * 1000);
      courses.push(data);
    }
    save(); render(); closeEditor();
  });
  btnDelete.addEventListener('click', function () {
    if (!editingId) return;
    askConfirm('确定删除该课程？').then(function (ok) {
      if (!ok) return;
      courses = courses.filter(function (c) { return c.id !== editingId; });
      save(); render(); closeEditor();
    });
  });
  document.getElementById('btnCancel').addEventListener('click', closeEditor);
  editor.addEventListener('click', function (e) { if (e.target === editor) closeEditor(); });
  // 周次快捷按钮
  var chips = document.querySelectorAll('#weekPicker .wp-chip');
  for (var ci = 0; ci < chips.length; ci++) {
    chips[ci].addEventListener('click', function () { setWeekVal(this.dataset.w); });
  }

  // ============ 设置 ============
  var settings = document.getElementById('settings');
  var sForm = document.getElementById('settingsForm');
  document.getElementById('btnSettings').addEventListener('click', function () {
    document.getElementById('sName').value = (activeTable() && activeTable().name) || config.term || '';
    document.getElementById('sMode').value = config.classMode || 'small';
    document.getElementById('sSections').value = config.sections;
    document.getElementById('sDays').value = config.days;
    document.getElementById('sTotalWeeks').value = config.totalWeeks;
    document.getElementById('sSemStart').value = config.semesterStart || '';
    document.getElementById('sTimes').value = (config.sectionTimes || []).join('\n');
    settings.classList.remove('hidden');
  });
  document.getElementById('sMode').addEventListener('change', function () {
    if (this.value === 'big') {
      document.getElementById('sSections').value = 4;
      document.getElementById('sTimes').value = genBigTimes().join('\n');
    } else {
      document.getElementById('sSections').value = 8;
      document.getElementById('sTimes').value = genDefaultTimes(8).join('\n');
    }
  });
  sForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var newMode = document.getElementById('sMode').value;
    var oldMode = config.classMode || 'small';
    var sec = parseInt(document.getElementById('sSections').value, 10);
    var days = parseInt(document.getElementById('sDays').value, 10);
    var tw = parseInt(document.getElementById('sTotalWeeks').value, 10);
    if (isNaN(sec) || sec < 1 || sec > 20) sec = (newMode === 'big' ? 4 : 8);
    if (days !== 5 && days !== 7) days = 7;
    if (isNaN(tw) || tw < 1 || tw > 40) tw = 20;
    var rawTimes = document.getElementById('sTimes').value.split('\n').map(function (x) { return x.trim(); }).filter(function (x) { return x; });
    if (newMode !== oldMode) {
      courses = courses.map(function (c) {
        var s, en;
        if (oldMode === 'big') { s = 2 * c.start - 1; en = 2 * (c.end || c.start); }
        else { s = Math.ceil(c.start / 2); en = Math.ceil((c.end || c.start) / 2); }
        var maxS = (newMode === 'big') ? 4 : 8;
        s = Math.min(Math.max(s, 1), maxS);
        en = Math.min(Math.max(en, s), maxS);
        return Object.assign({}, c, { start: s, end: en });
      });
    }
    var def = (newMode === 'big') ? (sec <= 4 ? genBigTimes() : genDefaultTimes(sec)) : genDefaultTimes(sec);
    config.sectionTimes = [];
    for (var ti = 0; ti < sec; ti++) config.sectionTimes.push(rawTimes[ti] || def[ti]);
    config.classMode = newMode;
    config.sections = sec; config.days = days;
    config.totalWeeks = tw;
    config.semesterStart = document.getElementById('sSemStart').value || '';
    var newName = document.getElementById('sName').value.trim();
    if (newName) { config.term = newName; var at = activeTable(); if (at) at.name = newName; }
    if (currentWeek > tw) currentWeek = tw;
    buildWeekGrid();
    save(); render(); settings.classList.add('hidden');
  });
  document.getElementById('sCancel').addEventListener('click', function () { settings.classList.add('hidden'); });

  // ============ 多课表：下拉切换 / 新建 / 删除 ============
  function renderTableMenu() {
    var items = store.tables.map(function (t) {
      var active = t.id === store.activeId;
      return '<button type="button" class="tm-item' + (active ? ' active' : '') + '" data-id="' + esc(t.id) + '">' +
        '<span class="tm-name">' + esc(t.name) + '</span>' +
        (active ? '<span class="tm-check">✓</span>' : '') + '</button>';
    }).join('');
    tableMenu.innerHTML = '<div class="tm-title">切换课表</div>' + items +
      '<button type="button" class="tm-new" id="tmNew">＋ 新建课表（新学期）</button>';
    tableMenu.querySelectorAll('.tm-item').forEach(function (el) {
      el.addEventListener('click', function () { switchTable(el.dataset.id); });
    });
    document.getElementById('tmNew').addEventListener('click', newTable);
  }
  function openTableMenu() {
    renderTableMenu();
    tableMenu.classList.remove('hidden');
    tableSwitcher.classList.add('open');
  }
  function closeTableMenu() {
    tableMenu.classList.add('hidden');
    tableSwitcher.classList.remove('open');
  }
  function switchTable(id) {
    if (id === store.activeId) { closeTableMenu(); return; }
    save();                       // 先把当前表存回去
    store.activeId = id;
    pullActiveIntoView();
    persist();
    buildWeekGrid(); render(); closeTableMenu();
    showToast('已切换到「' + ((activeTable() && activeTable().name) || '') + '」');
  }
  function newTable() {
    save();
    var t = makeEmptyTable('新课表');
    store.tables.push(t);
    store.activeId = t.id;
    pullActiveIntoView();
    persist();
    buildWeekGrid(); render(); closeTableMenu();
    showToast('已新建「新课表」，可在设置里改名');
  }
  function deleteCurrentTable() {
    if (store.tables.length <= 1) {
      // 最后一张不允许删除，改为清空该表课程
      askConfirm('这是最后一张课表，无法删除。是否清空这张课表的所有课程？', '清空课程').then(function (ok) {
        if (!ok) return;
        courses = []; save(); render(); showToast('已清空课程');
      });
      return;
    }
    var cur = activeTable();
    askConfirm('确定删除课表「' + (cur ? cur.name : '') + '」？删除后不可恢复（建议先导出备份）。', '删除课表').then(function (ok) {
      if (!ok) return;
      store.tables = store.tables.filter(function (t) { return t.id !== store.activeId; });
      store.activeId = store.tables[0].id;
      pullActiveIntoView();
      persist();
      buildWeekGrid(); render();
      showToast('已删除课表');
    });
  }
  tableBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    if (tableMenu.classList.contains('hidden')) openTableMenu(); else closeTableMenu();
  });
  document.addEventListener('click', function (e) {
    if (!tableSwitcher.contains(e.target)) closeTableMenu();
  });

  // ============ 周导航按钮 ============
  document.getElementById('prevWeek').addEventListener('click', function () { goWeek(currentWeek - 1); });
  document.getElementById('nextWeek').addEventListener('click', function () { goWeek(currentWeek + 1); });

  // ============ 导入/导出 ============
  document.getElementById('btnExport').addEventListener('click', function () {
    var blob = new Blob([JSON.stringify({ config: config, courses: courses, view: { currentWeek: currentWeek } }, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '课表.json';
    a.click();
    URL.revokeObjectURL(a.href);
  });
  var fileInput = document.getElementById('fileInput');
  var pdfInput = document.getElementById('pdfInput');
  // 合并导入：点「导入」先弹选择，再选 JSON / PDF
  var importModal = document.getElementById('importModal');
  function openImportModal() { importModal.classList.remove('hidden'); }
  function closeImportModal() { importModal.classList.add('hidden'); }
  document.getElementById('btnImport').addEventListener('click', openImportModal);
  document.getElementById('importCancel').addEventListener('click', closeImportModal);
  importModal.addEventListener('click', function (e) { if (e.target === importModal) closeImportModal(); });
  document.getElementById('importJson').addEventListener('click', function () { closeImportModal(); fileInput.click(); });
  document.getElementById('importPdf').addEventListener('click', function () { closeImportModal(); pdfInput.click(); });
  fileInput.addEventListener('change', function () {
    var f = fileInput.files[0]; if (!f) return;
    var r = new FileReader();
    r.onload = function () {
      try {
        var data = JSON.parse(r.result);
        if (data.config) {
          config = Object.assign(defaultConfig(), data.config);
          if (typeof config.totalWeeks !== 'number' || config.totalWeeks < 1) config.totalWeeks = 20;
        }
        if (Array.isArray(data.courses)) courses = data.courses.map(function (c) { if (c.week == null) c.week = (c.weeks || 'all'); return c; });
        if (data.view && typeof data.view.currentWeek === 'number') currentWeek = Math.min(Math.max(data.view.currentWeek, 1), config.totalWeeks);
        buildWeekGrid();
        save(); render();
      } catch (e) { showToast('文件格式不正确'); }
    };
    r.readAsText(f);
    fileInput.value = '';
  });

  // ============ 清空 ============
  document.getElementById('btnClear').addEventListener('click', deleteCurrentTable);

  // ============ PDF 导入（文字 PDF 直接提取；图片 PDF 走 OCR） ============
  var pdfModal = document.getElementById('pdfModal');
  var pdfStatus = document.getElementById('pdfStatus');
  var pdfTable = document.getElementById('pdfTable');
  var pdfConfirm = document.getElementById('pdfConfirm');
  var pdfAppend = document.getElementById('pdfAppend');
  var pdfCourses = [];

  function loadScript(src) {
    return new Promise(function (res, rej) {
      if (document.querySelector('script[src="' + src + '"]')) return res();
      var s = document.createElement('script');
      s.src = src; s.onload = function () { res(); };
      s.onerror = function () { rej(new Error('脚本加载失败: ' + src)); };
      document.head.appendChild(s);
    });
  }
  function setPdfStatus(t) { pdfStatus.textContent = t; }
  function openPdfModal(status) {
    pdfCourses = []; pdfTable.innerHTML = ''; pdfConfirm.disabled = true;
    setPdfStatus(status || '准备中…');
    pdfModal.classList.remove('hidden');
  }
  function closePdfModal() { pdfModal.classList.add('hidden'); }

  function importPdf(file) {
    openPdfModal('正在读取 PDF…');
    var reader = new FileReader();
    reader.onload = function () {
      var bytes = new Uint8Array(reader.result);
      var bin = '', CHUNK = 0x8000;
      for (var i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      runPdfImport(btoa(bin)).catch(function (e) {
        setPdfStatus('导入失败：' + (e && e.message ? e.message : e) + '。可改用「导入JSON」。');
      });
    };
    reader.onerror = function () { setPdfStatus('文件读取失败。'); };
    reader.readAsArrayBuffer(file);
  }

  // 本地服务转发 -> 腾讯云表格识别 V3；识别结果仍走现有核对表格
  function runPdfImport(b64) {
    setPdfStatus('正在上传 PDF 并调用腾讯云表格识别（可能需要十几秒）…');
    return fetch('/api/ocr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdfBase64: b64 })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok || !j.ok) {
          var msg = j.error || ('HTTP ' + r.status);
          if (r.status === 503 || j.configured === false) msg += '（先配置 .env 密钥并重启服务）';
          throw new Error(msg);
        }
        return j;
      });
    }).then(function (j) {
      var list = j.courses || [];
      if (!list.length) throw new Error('未识别到课程，请确认 PDF 内容或改用「导入JSON」');
      var pg = (j.pages || []).length;
      setPdfStatus('云端识别完成：' + pg + ' 页 / ' + list.length + ' 门课。请核对下方表格后导入。');
      finishPdfImport(list);
    });
  }

  // 抽出全部文字/词（文字层或 OCR），统一为 {text,x0,y0,x1,y1,top}
  function extractWords(doc) {
    return doc.getPage(1).then(function (p) { return p.getTextContent(); }).then(function (tc) {
      if (tc.items.length > 3) {
        // 有文字层，直接逐页取文本坐标
        return extractTextLayer(doc);
      }
      // 图片型：逐页渲染后 OCR
      return extractOcr(doc);
    });
  }

  function extractTextLayer(doc) {
    var all = [];
    var chain = Promise.resolve();
    for (var p = 1; p <= doc.numPages; p++) {
      (function (pn) {
        chain = chain.then(function () {
          return doc.getPage(pn).then(function (page) {
            var H = page.view[3];
            return page.getTextContent().then(function (tc) {
              tc.items.forEach(function (it) {
                var t = (it.str || '').trim();
                if (!t) return;
                var x = it.transform[4], yUp = it.transform[5];
                var w = (it.width || 5), h = (it.height || 11);
                all.push({ text: t, x0: x, y0: H - yUp, x1: x + w, y1: H - yUp - h, top: H - yUp });
              });
            });
          });
        });
      })(p);
    }
    return chain.then(function () { return all; });
  }

  function extractOcr(doc) {
    setPdfStatus('检测到图片型 PDF，正在进行 OCR 识别（首次需联网下载识别模型，请稍候）…');
    return loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js').then(function () {
      var all = [];
      var workerPromise = Tesseract.createWorker({ logger: function () {} });
      var chain = workerPromise.then(function (w) { return w.loadLanguage('chi_sim+eng').then(function () { return w.initialize('chi_sim+eng'); }).then(function () { return w; }); });
      for (var p = 1; p <= doc.numPages; p++) {
        (function (pn) {
          chain = chain.then(function (w) {
            return doc.getPage(pn).then(function (page) {
              var vp = page.getViewport({ scale: 2.5 });
              var canvas = document.createElement('canvas');
              canvas.width = vp.width; canvas.height = vp.height;
              return page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise.then(function () {
                return w.recognize(canvas).then(function (out) {
                  (out.data.words || []).forEach(function (wd) {
                    all.push({ text: wd.text.trim(), x0: wd.bbox.x0, y0: wd.bbox.y0, x1: wd.bbox.x1, y1: wd.bbox.y1, top: wd.bbox.y0 });
                  });
                });
              });
            });
          });
        })(p);
      }
      return chain.then(function (w) { return w.terminate().then(function () { return all; }); });
    });
  }

  var DAY_NAMES = { '星期一': 1, '星期二': 2, '星期三': 3, '星期四': 4, '星期五': 5, '星期六': 6, '星期日': 7,
    '周一': 1, '周二': 2, '周三': 3, '周四': 4, '周五': 5, '周六': 6, '周日': 7 };

  // 从识别出的词集合，重建成 (星期,节次区) 网格并解析出课程
  function buildCoursesFromWords(words) {
    var minX = Math.min.apply(null, words.map(function (w) { return w.x0; }));
    var maxX = Math.max.apply(null, words.map(function (w) { return w.x1; }));
    var width = maxX - minX || 1;

    // 找到星期表头词 → 列 x 中心
    var headerWords = words.filter(function (w) { return DAY_NAMES[w.text] != null; });
    var cols = headerWords.map(function (w) {
      return { day: DAY_NAMES[w.text], x: (w.x0 + w.x1) / 2 };
    }).sort(function (a, b) { return a.x - b.x; });
    // 去重相邻的同一列
    var cols2 = [];
    cols.forEach(function (c) { if (!cols2.length || c.x - cols2[cols2.length - 1].x > width * 0.04) cols2.push(c); });
    cols = cols2;

    // 找到最左侧的节次区行标签（一/二/三…）→ 行 y 中心
    var rowLabels = words.filter(function (w) {
      return w.x0 < minX + width * 0.14 && /^[一二三四五六七八九十]$/.test(w.text);
    });
    var rows = rowLabels.map(function (w) { return { label: w.text, top: (w.top + w.y1) / 2 }; })
      .sort(function (a, b) { return a.top - b.top; });
    var rows2 = [];
    rows.forEach(function (r) { if (!rows2.length || r.top - rows2[rows2.length - 1].top > 20) rows2.push(r); });
    rows = rows2;

    function dayOf(w) {
      if (!cols.length) return 1;
      var best = 0, bd = 1e9;
      cols.forEach(function (c) { var d = Math.abs(c.x - (w.x0 + w.x1) / 2); if (d < bd) { bd = d; best = c.day; } });
      return best;
    }
    function sectionOf(w) {
      if (!rows.length) return 1;
      var best = 0, bd = 1e9;
      rows.forEach(function (r, i) { var d = Math.abs(r.top - w.top); if (d < bd) { bd = d; best = i + 1; } });
      return best;
    }

    var cells = {};
    words.forEach(function (w) {
      if (DAY_NAMES[w.text] != null) return;              // 跳过表头
      if (rows.some(function (r) { return Math.abs(r.top - w.top) < 8 && w.x0 < minX + width * 0.14; })) return; // 跳过行标签
      if (!/[一-龥]/.test(w.text) && !/[A-Za-z]/.test(w.text)) return;
      var key = dayOf(w) + ':' + sectionOf(w);
      if (!cells[key]) cells[key] = [];
      cells[key].push(w);
    });

    var list = [];
    Object.keys(cells).forEach(function (key) {
      var parts = key.split(':');
      var day = +parts[0], sec = +parts[1];
      var ws = cells[key].sort(function (a, b) { return a.top - b.top; });
      var text = ws.map(function (w) { return w.text; }).join('\n');
      var c = parseCell(text);
      if (!c) return;
      c.day = day; c.start = sec; c.end = sec;
      c.color = '#4f86f7';
      list.push(c);
    });
    return list;
  }

  // 解析单格文本：课程名，教师【周次】，地点
  function parseCell(text) {
    if (!text || !/[一-龥]/.test(text)) return null;
    var week = null;
    var m = text.match(/【?\s*(\d{1,2})\s*[-~到至]\s*(\d{1,2})\s*周】?/);
    if (m) week = m[1] + '-' + m[2];
    else { var m2 = text.match(/【?\s*(\d{1,2})\s*周】?/); if (m2) week = m2[1]; }
    var loc = null;
    var lm = text.match(/[A-Za-z]\d\s*-\s*\d{2,4}|[（(]?[^\s,，\n】]{0,14}(校区|楼|室)[）)]?/);
    if (lm) loc = lm[0].replace(/\s/g, '');
    var teacher = null;
    var tm = text.match(/([一-龥]{2,4})\s*【/);
    if (tm) teacher = tm[1];
    var name = text.replace(/【[^】]*】/g, '')
      .replace(loc || '', '')
      .replace(teacher || '', '')
      .replace(/[，,]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[\s\-–]+|[\s\-–]+$/g, '')
      .trim();
    if (!name) return null;
    return { name: name, teacher: teacher, location: loc, week: parseWeekInput(week || 'all') };
  }

  function finishPdfImport(list) {
    // 根据需要扩展网格，避免课程被丢弃
    var maxS = 0, maxD = 0;
    list.forEach(function (c) { maxS = Math.max(maxS, c.start); maxD = Math.max(maxD, c.day); });
    if (maxD > config.days) config.days = maxD;
    if (maxS > config.sections) {
      var def = genDefaultTimes(maxS);
      for (var i = config.sectionTimes.length; i < maxS; i++) config.sectionTimes.push(def[i] || ('第' + (i + 1) + '节'));
      config.sections = maxS;
    }
    pdfCourses = list;
    renderPdfTable();
    setPdfStatus('共识别 ' + list.length + ' 门课程。请核对「星期 / 节次 / 周次」，可直接修改，确认后导入。');
    pdfConfirm.disabled = false;
    pdfAppend.disabled = false;
  }

  function renderPdfTable() {
    var head = '<tr><th>星期</th><th>节次</th><th>课程名</th><th>教师</th><th>地点</th><th>周次</th></tr>';
    var body = pdfCourses.map(function (c, i) {
      var dayOpts = '';
      for (var d = 1; d <= 7; d++) dayOpts += '<option value="' + d + '"' + (d === c.day ? ' selected' : '') + '>' + DAY_LABELS[d - 1] + '</option>';
      return '<tr>' +
        '<td><select data-i="' + i + '" data-f="day">' + dayOpts + '</select></td>' +
        '<td><input type="number" min="1" data-i="' + i + '" data-f="start" value="' + c.start + '" style="width:48px"/></td>' +
        '<td><input data-i="' + i + '" data-f="name" value="' + esc(c.name) + '" style="min-width:160px"/></td>' +
        '<td><input data-i="' + i + '" data-f="teacher" value="' + esc(c.teacher || '') + '" style="width:70px"/></td>' +
        '<td><input data-i="' + i + '" data-f="location" value="' + esc(c.location || '') + '" style="width:80px"/></td>' +
        '<td><input data-i="' + i + '" data-f="week" value="' + esc(Array.isArray(c.week) ? c.week.join(',') : String(c.week)) + '" style="width:70px" placeholder="all/5-8"/></td>' +
        '</tr>';
    }).join('');
    pdfTable.innerHTML = head + body;
    pdfTable.querySelectorAll('[data-i]').forEach(function (el) {
      el.addEventListener('change', function () {
        var i = +el.dataset.i, f = el.dataset.f;
        if (f === 'day') pdfCourses[i].day = +el.value;
        else if (f === 'start') pdfCourses[i].start = +el.value || 1;
        else pdfCourses[i][f] = el.value;
      });
    });
  }

  pdfInput.addEventListener('change', function () {
    var f = pdfInput.files[0]; if (!f) return;
    importPdf(f); pdfInput.value = '';
  });
  document.getElementById('pdfCancel').addEventListener('click', closePdfModal);
  pdfModal.addEventListener('click', function (e) { if (e.target === pdfModal) closePdfModal(); });
  function commitPdfImport(mode) {
    var incoming = pdfCourses.map(function (c) {
      return {
        id: 'c' + Date.now() + Math.floor(Math.random() * 1000),
        name: c.name, teacher: c.teacher || '', location: c.location || '',
        day: +c.day, start: +c.start, end: +c.start,
        week: parseWeekInput(Array.isArray(c.week) ? c.week.join(',') : String(c.week)),
        color: c.color || '#4f86f7', note: c.note || ''
      };
    });
    // 默认「替换」：不清旧数据会导致每次导入叠加、同一门课显示多份。
    courses = (mode === 'append') ? courses.concat(incoming) : incoming;
    save(); render(); closePdfModal();
    showToast('已' + (mode === 'append' ? '追加' : '替换') + '导入 ' + incoming.length + ' 门课程。');
  }
  pdfConfirm.addEventListener('click', function () { commitPdfImport('replace'); });
  pdfAppend.addEventListener('click', function () {
    askConfirm('把识别结果加到现有课程后面？若课表已有这些课，可能出现重复。', '追加导入').then(function (ok) {
      if (ok) commitPdfImport('append');
    });
  });

  // 窗口尺寸变化时重新铺满（防抖）
  var fitTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(fitGridHeight, 120);
  });

  // ============ 启动 ============
  load();            // 先读出当前课表（含旧数据迁移）
  buildWeekGrid();   // 再按该课表的节次数建网格
  render();
})();
