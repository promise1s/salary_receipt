const { app, BrowserWindow, Tray, Menu, screen, nativeImage, ipcMain } = require('electron');
const path = require('path');
const zlib = require('zlib');
const fs = require('fs');
const { startServer } = require('./electron-server.cjs');

let tray = null;
let mainWindow = null;
let serverProcess = null;
let currentPort = null;
let trayIconTimer = null;

// ─── 平台检测 ──────────────────────────────────────────────────────────────────
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

const UI_UPGRADE = {
  window: {
    width: 320,
    height: 560,
    background: '#FFFFFF',
    cornerRadius: 16,
    contentScale: 0.82,
  },
  menubar: {
    width: 60,
    height: 22,
    barCount: 5,
    barWidth: 5,
    barHeight: 13,
    barGap: 3,
    emptyOpacity: 0.2,
    refreshSeconds: 10,
  },
  copy: {
    monthly: 'MONTHLY INCOME',
    fullTime: 'FULL TIME AFTER',
    retirement: 'RETIREMENT',
    hourlyFormatSlash: ' / ',
  },
  colors: {
    background: '#FFFFFF',
    textPrimary: '#1F2026',
    textSecondary: '#6E7280',
    textMuted: '#A9ADB8',
    divider: '#D4D7DE',
    buttonBorder: '#E5A000',
    buttonText: '#5A5E69',
    dotGrid: '#ECEEF3',
  },
  typography: {
    sizes: {
      title: 25,
      date: 16,
      sectionTitle: 20,
      primaryAmount: 48,
      hourlyRate: 19,
      subsidyLabel: 16,
      subsidyTime: 16,
      infoLabel: 16,
      infoValue: 16,
      wishlistItem: 18,
      wishlistMeta: 14,
      wishlistPrice: 14,
      footer: 15,
      button: 16,
    },
  },
  divider: {
    dash: 5,
    gap: 4,
    opacity: 0.95,
  },
};

const DEFAULT_WORKING_HOURS_RANGE = '09:30-18:30';
let workingHoursRange = DEFAULT_WORKING_HOURS_RANGE;

function getSettingsPath() {
  try {
    return path.join(app.getPath('userData'), 'salary-receipt-settings.json');
  } catch {
    return null;
  }
}

function normalizeWorkingHoursRange(rangeStr) {
  const s = String(rangeStr || '').trim().replace(/\s+/g, '');
  const m = s.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const startHH = Number(m[1]);
  const startMM = Number(m[2]);
  const endHH = Number(m[3]);
  const endMM = Number(m[4]);
  const ok = (hh, mm) => Number.isFinite(hh) && Number.isFinite(mm) && hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59;
  if (!ok(startHH, startMM) || !ok(endHH, endMM)) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(startHH)}:${pad(startMM)}-${pad(endHH)}:${pad(endMM)}`;
}

function loadSettings() {
  const settingsPath = getSettingsPath();
  if (!settingsPath) return;
  try {
    if (!fs.existsSync(settingsPath)) return;
    const raw = fs.readFileSync(settingsPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.workingHoursRange === 'string') {
      const normalized = normalizeWorkingHoursRange(parsed.workingHoursRange);
      if (normalized) workingHoursRange = normalized;
    }
  } catch (error) {
    console.warn('Failed to load settings:', error);
  }
}

function saveSettings() {
  const settingsPath = getSettingsPath();
  if (!settingsPath) return;
  try {
    fs.writeFileSync(settingsPath, JSON.stringify({ workingHoursRange }, null, 2), 'utf8');
  } catch (error) {
    console.warn('Failed to save settings:', error);
  }
}

function isWorkday(date = new Date()) {
  const day = date.getDay();
  return day !== 0 && day !== 6;
}

function parseHHMM(hhmm) {
  const [hh, mm] = String(hhmm).split(':').map((v) => parseInt(v, 10));
  return {
    hh: Number.isFinite(hh) ? hh : 0,
    mm: Number.isFinite(mm) ? mm : 0,
  };
}

function atTodayTime(date, hhmm) {
  const { hh, mm } = parseHHMM(hhmm);
  const d = new Date(date);
  d.setHours(hh, mm, 0, 0);
  return d;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function getTodayWorkProgress(now = new Date()) {
  if (!isWorkday(now)) {
    return { elapsed: 0, total: 1, ratio: 0, start: null, end: null };
  }

  const normalized = normalizeWorkingHoursRange(workingHoursRange) || DEFAULT_WORKING_HOURS_RANGE;
  const [startStr, endStr] = normalized.split('-');
  const start = atTodayTime(now, startStr);
  const end = atTodayTime(now, endStr);

  if (end <= start) {
    return { elapsed: 0, total: 1, ratio: 0, start, end };
  }

  const total = Math.max(1, Math.floor((end - start) / 1000));

  if (now < start) {
    return { elapsed: 0, total, ratio: 0, start, end };
  }

  if (now >= end) {
    return { elapsed: total, total, ratio: 1, start, end };
  }

  const elapsed = Math.max(0, Math.floor((now - start) / 1000));
  const ratio = clamp(elapsed / total, 0, 1);
  return { elapsed, total, ratio, start, end };
}

function ratioToBars(ratio) {
  return clamp(Math.ceil(clamp(ratio, 0, 1) * UI_UPGRADE.menubar.barCount), 0, UI_UPGRADE.menubar.barCount);
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function rgbaToPngBuffer(rgba, width, height) {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + stride);
    raw[rowStart] = 0;
    rgba.copy(raw, rowStart + 1, y * stride, (y + 1) * stride);
  }

  const compressed = zlib.deflateSync(raw, { level: 9 });
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ─── [改动1] 进度条颜色：Windows用白色（深色任务栏可见），macOS用黑色（setTemplate会反色）
function drawBarsToRgba({ filled, total }) {
  const scale = 2;
  const width = UI_UPGRADE.menubar.width * scale;
  const height = UI_UPGRADE.menubar.height * scale;
  const rgba = Buffer.alloc(width * height * 4, 0x00);

  const barWidth = UI_UPGRADE.menubar.barWidth * scale;
  const barHeight = UI_UPGRADE.menubar.barHeight * scale;
  const gap = UI_UPGRADE.menubar.barGap * scale;
  const totalWidth = total * barWidth + (total - 1) * gap;
  const left = Math.floor((width - totalWidth) / 2);
  const top = Math.floor((height - barHeight) / 2);
  const emptyAlpha = Math.round(255 * UI_UPGRADE.menubar.emptyOpacity);

  // Windows任务栏默认深色，用白色图标；macOS用黑色（setTemplateImage会自动反色适配深浅模式）
  const pixelR = IS_WIN ? 255 : 0;
  const pixelG = IS_WIN ? 255 : 0;
  const pixelB = IS_WIN ? 255 : 0;

  function setPixel(x, y, r, g, b, a) {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    rgba[i] = r;
    rgba[i + 1] = g;
    rgba[i + 2] = b;
    rgba[i + 3] = a;
  }

  for (let i = 0; i < total; i++) {
    const x0 = left + i * (barWidth + gap);
    const y0 = top;
    const x1 = x0 + barWidth - 1;
    const y1 = y0 + barHeight - 1;
    const isFilled = i < filled;

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const onBorder = (x === x0 || x === x1 || y === y0 || y === y1);
        if (isFilled) {
          setPixel(x, y, pixelR, pixelG, pixelB, 255);
        } else if (onBorder) {
          setPixel(x, y, pixelR, pixelG, pixelB, emptyAlpha);
        }
      }
    }
  }

  return { rgba, width, height };
}

// ─── [改动2] setTemplateImage 仅在 macOS 上调用，Windows不支持此API
function makeProgressNativeImage(now = new Date()) {
  const { ratio } = getTodayWorkProgress(now);
  const filled = ratioToBars(ratio);
  const { rgba, width, height } = drawBarsToRgba({ filled, total: UI_UPGRADE.menubar.barCount });
  const png = rgbaToPngBuffer(rgba, width, height);
  let img = nativeImage.createFromBuffer(png);

  if (!img || img.isEmpty()) {
    img = nativeImage.createFromBuffer(
      Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
    );
  }

  img = img.resize({ width: UI_UPGRADE.menubar.width, height: UI_UPGRADE.menubar.height });

  // setTemplateImage 是 macOS 专属 API，让系统根据深浅色模式自动反色
  // Windows 上调用此方法会导致图标变成黑色方块，必须跳过
  if (IS_MAC) {
    img.setTemplateImage(true);
  }

  return img;
}

function updateTrayIcon() {
  if (!tray) return;
  try {
    const now = new Date();
    const { ratio } = getTodayWorkProgress(now);
    tray.setImage(makeProgressNativeImage(now));
    const normalized = normalizeWorkingHoursRange(workingHoursRange) || DEFAULT_WORKING_HOURS_RANGE;
    tray.setToolTip(`Salary Receipt · ${normalized} · ${Math.round(ratio * 100)}%`);
  } catch (error) {
    console.error('Failed to update tray icon:', error);
  }
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

// app.dock 仅 macOS 存在，Windows 上安全跳过
if (app.dock) app.dock.hide();

function createMainWindow(port) {
  mainWindow = new BrowserWindow({
    width: UI_UPGRADE.window.width,
    height: UI_UPGRADE.window.height,
    show: false,
    frame: false,
    transparent: false,
    backgroundColor: UI_UPGRADE.window.background,
    resizable: false,
    fullscreenable: false,
    // Windows上 movable:false 会导致窗口完全无法拖动且定位有时异常，改为可移动
    movable: IS_WIN ? true : false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindow.setBackgroundColor(UI_UPGRADE.window.background);

  const startUrl = process.env.ELECTRON_START_URL || `http://localhost:${port}`;
  mainWindow.loadURL(startUrl).catch((error) => {
    console.error('Failed to load main window URL:', error);
    setTimeout(() => mainWindow.loadURL(startUrl), 1000);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    const css = `
      html, body, #root {
        width: 100% !important;
        height: 100% !important;
        margin: 0 !important;
        padding: 0 !important;
        overflow: hidden !important;
        background: ${UI_UPGRADE.colors.background} !important;
        color: ${UI_UPGRADE.colors.textPrimary} !important;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace !important;
      }

      body {
        box-sizing: border-box !important;
      }

      *, *::before, *::after {
        box-sizing: border-box !important;
      }

      #root > * {
        width: 100% !important;
        height: 100% !important;
        margin: 0 !important;
        padding: 0 !important;
        background: ${UI_UPGRADE.colors.background} !important;
      }

      :where(.appShell,.container,.wrapper,.layout,.root,.App,.app,.card,.receiptCard,.receipt,.paper) {
        width: 100% !important;
        height: 100% !important;
        margin: 0 !important;
        padding: 0 !important;
        border: none !important;
        border-radius: 0 !important;
        box-shadow: none !important;
        background: ${UI_UPGRADE.colors.background} !important;
      }

      button, input, textarea, select {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace !important;
      }

      hr, [class*="divider"], [class*="Divider"], [class*="separator"], [class*="Separator"] {
        height: 1px !important;
        border: none !important;
        background-image: repeating-linear-gradient(
          to right,
          ${UI_UPGRADE.colors.divider},
          ${UI_UPGRADE.colors.divider} ${UI_UPGRADE.divider.dash}px,
          transparent ${UI_UPGRADE.divider.dash}px,
          transparent ${UI_UPGRADE.divider.dash + UI_UPGRADE.divider.gap}px
        ) !important;
        opacity: ${UI_UPGRADE.divider.opacity} !important;
      }
    `;

    mainWindow.webContents.insertCSS(css).catch(() => {});

    try {
      mainWindow.webContents.setZoomFactor(UI_UPGRADE.window.contentScale);
    } catch {}

    mainWindow.webContents.executeJavaScript(`
      (function () {
        const replacers = [
          [/MONTHLY\\s+CUMULATIVE\\s+INCOME/gi, ${JSON.stringify(UI_UPGRADE.copy.monthly)}],
          [/DAYS\\s+UNTIL\\s+WORK\\s+START/gi, ${JSON.stringify(UI_UPGRADE.copy.fullTime)}],
          [/RETIREMENT\\s+IN/gi, ${JSON.stringify(UI_UPGRADE.copy.retirement)}],
          [/([¥$€£]\\s*\\d+(?:\\.\\d+)?)\\s*\\/\\s*H\\b/g, '$1${UI_UPGRADE.copy.hourlyFormatSlash}H'],
        ];

        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
        const textNodes = [];
        while (walker.nextNode()) textNodes.push(walker.currentNode);
        textNodes.forEach((node) => {
          let value = node.nodeValue || '';
          for (const [pattern, replacement] of replacers) {
            value = value.replace(pattern, replacement);
          }
          node.nodeValue = value;
        });

        const getText = (el) => (el && (el.innerText || el.textContent || '') || '').trim();
        const all = Array.from(document.querySelectorAll('body *'));
        const smallStyleMap = [
          { max: 12.5, size: ${UI_UPGRADE.typography.sizes.infoLabel} },
          { max: 13.5, size: ${UI_UPGRADE.typography.sizes.wishlistItem} },
          { max: 14.5, size: ${UI_UPGRADE.typography.sizes.sectionTitle} },
          { max: 16.5, size: ${UI_UPGRADE.typography.sizes.infoValue} },
        ];

        all.forEach((el) => {
          const text = getText(el);
          if (!text) return;

          const cs = window.getComputedStyle(el);
          const fontSize = parseFloat(cs.fontSize || '0');
          if (!Number.isFinite(fontSize) || fontSize <= 0) return;

          if (/^SALARY\\s+RECEIPT$/i.test(text)) {
            el.style.fontSize = '${UI_UPGRADE.typography.sizes.title}px';
            el.style.letterSpacing = '0.14em';
            el.style.fontWeight = '700';
            el.style.textAlign = 'center';
            return;
          }

          if (/^DATE:/i.test(text)) {
            el.style.fontSize = '${UI_UPGRADE.typography.sizes.date}px';
            el.style.color = '${UI_UPGRADE.colors.textSecondary}';
            el.style.textAlign = 'center';
            return;
          }

          if (/^TODAY\\s+EARNED$/i.test(text)) {
            el.style.fontSize = '${UI_UPGRADE.typography.sizes.sectionTitle}px';
            el.style.letterSpacing = '0.12em';
            el.style.fontWeight = '500';
            el.style.textAlign = 'center';
            return;
          }

          if (/^[¥$€£]\\s*\\d[\\d,]*(?:\\.\\d{1,2})?$/.test(text)) {
            if (fontSize >= 22) {
              el.style.fontSize = '${UI_UPGRADE.typography.sizes.primaryAmount}px';
              el.style.fontWeight = '700';
              el.style.lineHeight = '1.1';
              el.style.textAlign = 'center';
              return;
            }
          }

          if (/^[¥$€£]\\s*\\d[\\d,]*(?:\\.\\d{1,2})?\\s*\/\\s*H$/i.test(text)) {
            el.style.fontSize = '${UI_UPGRADE.typography.sizes.hourlyRate}px';
            el.style.color = '${UI_UPGRADE.colors.textSecondary}';
            el.style.letterSpacing = '0.02em';
            el.style.textAlign = 'center';
            return;
          }

          if (/^(MEAL\\s+SUBSIDY|TAXI\\s+SUBSIDY)$/i.test(text)) {
            el.style.fontSize = '${UI_UPGRADE.typography.sizes.subsidyLabel}px';
            el.style.color = '${UI_UPGRADE.colors.textSecondary}';
            el.style.letterSpacing = '0.08em';
            return;
          }

          if (/^\\d{1,5}:\\d{2}:\\d{2}$/.test(text)) {
            el.style.fontSize = '${UI_UPGRADE.typography.sizes.subsidyTime}px';
            el.style.color = '${UI_UPGRADE.colors.textPrimary}';
            return;
          }

          if (/^(MONTHLY\\s+INCOME|FULL\\s+TIME\\s+AFTER|RETIREMENT)$/i.test(text)) {
            el.style.fontSize = '${UI_UPGRADE.typography.sizes.infoLabel}px';
            el.style.color = '${UI_UPGRADE.colors.textSecondary}';
            el.style.letterSpacing = '0.08em';
            return;
          }

          if (/^(WISHLIST)$/i.test(text)) {
            el.style.fontSize = '${UI_UPGRADE.typography.sizes.sectionTitle}px';
            el.style.letterSpacing = '0.12em';
            el.style.fontWeight = '500';
            return;
          }

          if (/^(Settings|v\\d+\\.\\d+\\.\\d+)$/i.test(text)) {
            el.style.fontSize = '${UI_UPGRADE.typography.sizes.footer}px';
            el.style.color = '${UI_UPGRADE.colors.textSecondary}';
            return;
          }

          for (const rule of smallStyleMap) {
            if (fontSize <= rule.max) {
              el.style.fontSize = rule.size + 'px';
              break;
            }
          }
        });
      })();
    `).catch(() => {});
  });

  mainWindow.webContents.setBackgroundThrottling(false);

  mainWindow.on('blur', () => {
    if (!mainWindow.webContents.isDevToolsOpened()) {
      mainWindow.hide();
    }
  });

  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
    return false;
  });
}

// ─── [改动3] 窗口弹出位置：macOS托盘在顶部往下弹，Windows托盘在右下角往上弹
function positionWindowNearTray(bounds) {
  if (!mainWindow) return;

  const windowBounds = mainWindow.getBounds();
  const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
  const workArea = display.workArea;

  // 水平方向：始终以托盘图标为中心对齐窗口
  let x = Math.round(bounds.x + bounds.width / 2 - windowBounds.width / 2);

  let y;
  if (IS_WIN) {
    // Windows：系统托盘在屏幕右下角，窗口从图标上方弹出
    y = Math.round(bounds.y - windowBounds.height - 6);
  } else {
    // macOS：menubar在屏幕顶部，窗口从图标下方弹出
    y = Math.round(bounds.y + bounds.height + 6);
  }

  // 边界保护：确保窗口不超出可用工作区
  x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - windowBounds.width));
  y = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - windowBounds.height));

  mainWindow.setPosition(x, y, false);
}

function showOrTogglePopover(bounds) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (!currentPort) return;
    createMainWindow(currentPort);
  }

  if (mainWindow.isVisible()) {
    mainWindow.hide();
    return;
  }

  positionWindowNearTray(bounds);
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  tray = new Tray(makeProgressNativeImage(new Date()));
  tray.setToolTip('Salary Receipt');

  tray.on('click', (_event, bounds) => {
    showOrTogglePopover(bounds);
  });

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '重启 Salary Receipt',
      click: () => {
        app.relaunch();
        app.exit(0);
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.on('right-click', () => {
    tray.popUpContextMenu(contextMenu);
  });

  tray.on('mouse-up', (event) => {
    if (event.ctrlKey) tray.popUpContextMenu(contextMenu);
  });
}

app.on('before-quit', () => {
  app.isQuitting = true;
  if (trayIconTimer) {
    clearInterval(trayIconTimer);
    trayIconTimer = null;
  }
});

app.whenReady().then(async () => {
  loadSettings();

  try {
    ipcMain.handle('salaryReceipt:getWorkingHoursRange', () => workingHoursRange);
    ipcMain.handle('salaryReceipt:setWorkingHoursRange', (_evt, rangeStr) => {
      const normalized = normalizeWorkingHoursRange(rangeStr);
      if (!normalized) {
        return { ok: false, error: 'Invalid range. Use HH:MM-HH:MM' };
      }
      workingHoursRange = normalized;
      saveSettings();
      updateTrayIcon();
      return { ok: true, value: workingHoursRange };
    });
  } catch (error) {
    console.warn('IPC setup skipped:', error);
  }

  try {
    const { server, port } = await startServer();
    serverProcess = server;
    currentPort = port;

    console.log('Internal server started on port:', port);

    createMainWindow(port);
    createTray();
    updateTrayIcon();
    trayIconTimer = setInterval(updateTrayIcon, UI_UPGRADE.menubar.refreshSeconds * 1000);

    app.on('activate', () => {});
  } catch (error) {
    console.error('Failed to start app:', error);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  // Menubar/tray app: 关闭所有窗口后继续保持运行（托盘常驻）
});
