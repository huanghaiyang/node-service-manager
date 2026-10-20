import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { load } from './helpers.mjs';

const icon = await load('icon.js');
const tray = await load('tray.js');

describe('buildIco（纯 JS 拼 ICO 字节）', () => {
  const ico = icon.buildIco({ sizes: [16, 32, 48] });

  test('ICONDIR 头正确', () => {
    assert.equal(ico.readUInt16LE(0), 0, 'reserved 应为 0');
    assert.equal(ico.readUInt16LE(2), 1, 'type 应为 1（图标）');
    assert.equal(ico.readUInt16LE(4), 3, 'count 应为尺寸个数');
  });

  test('每个 ICONDIRENTRY 的尺寸/位深/偏移自洽', () => {
    const count = ico.readUInt16LE(4);
    let expectOffset = 6 + 16 * count;
    for (let i = 0; i < count; i += 1) {
      const b = 6 + i * 16;
      const w = ico.readUInt8(b);
      const h = ico.readUInt8(b + 1);
      assert.equal(w, h, '条目标注应为正方形');
      assert.equal(ico.readUInt16LE(b + 4), 1, 'planes 应为 1');
      assert.equal(ico.readUInt16LE(b + 6), 32, '应为 32 位');
      const len = ico.readUInt32LE(b + 8);
      const off = ico.readUInt32LE(b + 12);
      assert.equal(off, expectOffset, `第 ${i} 个偏移应为累加值`);
      expectOffset += len;
    }
    assert.equal(expectOffset, ico.length, '总长度应正好覆盖所有条目');
  });

  test('BMP(DIB) 段头正确（高度要为 2 倍，含 AND 掩码）', () => {
    const firstOff = ico.readUInt32LE(6 + 12);
    const size = ico.readUInt8(6); // 16
    assert.equal(ico.readUInt32LE(firstOff), 40, 'biSize');
    assert.equal(ico.readInt32LE(firstOff + 4), size, 'biWidth');
    assert.equal(ico.readInt32LE(firstOff + 8), size * 2, 'biHeight = XOR + AND');
    assert.equal(ico.readUInt16LE(firstOff + 12), 1, 'biPlanes');
    assert.equal(ico.readUInt16LE(firstOff + 14), 32, 'biBitCount');
    assert.equal(ico.readUInt32LE(firstOff + 16), 0, 'BI_RGB');
  });
});

describe('samplePixel（同一套图形：渐变圆角方块 + 白色齿轮）', () => {
  test('圆角之外完全透明', () => {
    for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      assert.equal(icon.samplePixel(u, v)[3], 0, `角落 (${u},${v}) 应透明`);
    }
  });

  test('方块内部不透明', () => {
    assert.equal(icon.samplePixel(0.5, 0.15)[3], 255);
    assert.equal(icon.samplePixel(0.15, 0.5)[3], 255);
  });

  test('齿轮盘为白色', () => {
    const px = icon.samplePixel(0.5, 0.5 - 0.2); // 齿盘内、不在中心孔
    assert.deepEqual(px.slice(0, 3), [255, 255, 255]);
  });

  test('中心镂空（不是白色）', () => {
    const px = icon.samplePixel(0.5, 0.5);
    assert.notDeepEqual(px.slice(0, 3), [255, 255, 255], '中心孔应露出背景渐变');
  });

  test('背景是上蓝下紫的渐变', () => {
    const top = icon.samplePixel(0.5, 0.06);
    const bottom = icon.samplePixel(0.5, 0.94);
    assert.ok(top[2] > top[0], '顶部应偏蓝（B > R）');
    assert.ok(bottom[0] > top[0], '底部应更红/紫');
  });
});

describe('renderPixels', () => {
  test('输出长度为 size²×4，且边缘有半透明像素（抗锯齿生效）', () => {
    const size = 24;
    const px = icon.renderPixels(size, { supersample: 4 });
    assert.equal(px.length, size * size * 4);
    let partial = 0;
    for (let i = 3; i < px.length; i += 4) {
      if (px[i] > 0 && px[i] < 255) partial += 1;
    }
    assert.ok(partial > 0, '圆角/齿轮边缘应存在半透明像素');
  });
});

describe('buildTrayScript（生成的 PowerShell）', () => {
  const script = tray.buildTrayScript({ port: 5199, iconPath: 'D:/data/tray/app.ico' });

  test('包含托盘与菜单要素', () => {
    for (const needle of ['NotifyIcon', 'ContextMenuStrip', 'System.Windows.Forms.Application]::Run()']) {
      assert.ok(script.includes(needle), `缺少 ${needle}`);
    }
  });

  test('菜单项齐全', () => {
    for (const label of ['打开控制台', '启动全部服务', '停止全部服务', '刷新状态', '退出托盘']) {
      assert.ok(script.includes(label), `缺少菜单项：${label}`);
    }
  });

  test('轮询轻量汇总接口，而不是完整服务列表', () => {
    assert.ok(script.includes("'/api/summary'"));
    assert.ok(!script.includes("'/api/services'"), '不应在托盘里拉完整服务列表');
  });

  test('端口与图标路径被正确注入', () => {
    assert.ok(script.includes('5178') === false, '默认端口不应写死成 5178');
    assert.ok(script.includes('$Port = 5199'), '端口应来自参数');
    assert.ok(script.includes('D:/data/tray/app.ico'));
  });

  test('图标路径里的单引号被转义（防注入）', () => {
    const s = tray.buildTrayScript({ port: 1, iconPath: "C:/a'b/app.ico" });
    assert.ok(s.includes("C:/a''b/app.ico"), '单引号应双写');
  });
});

describe('托盘资源与状态', () => {
  test('ensureTrayAssets 生成 ico 与 ps1，且 ps1 带 UTF-8 BOM', async () => {
    const assets = await tray.ensureTrayAssets(5199);
    assert.ok(fs.existsSync(assets.icon));
    assert.ok(fs.existsSync(assets.script));
    const head = fs.readFileSync(assets.script).subarray(0, 3);
    // Windows PowerShell 5.1 没有 BOM 时会按系统 ANSI 读，中文会变乱码并导致解析失败
    assert.deepEqual([...head], [0xef, 0xbb, 0xbf], '.ps1 必须带 UTF-8 BOM');
    const ico = fs.readFileSync(assets.icon);
    assert.equal(ico.readUInt16LE(2), 1, '应是一个合法 ICO');
  });

  test('getTrayStatus 字段完整，未启动时 running=false', () => {
    const st = tray.getTrayStatus();
    assert.equal(typeof st.supported, 'boolean');
    assert.equal(st.running, false);
    assert.equal(st.pid, null);
    for (const key of ['icon', 'script', 'log', 'detail', 'mechanism']) {
      assert.ok(key in st, `缺少字段 ${key}`);
    }
    if (process.platform === 'win32') {
      assert.equal(st.supported, true);
      assert.equal(st.mechanism, 'powershell-notifyicon');
    } else {
      assert.equal(st.supported, false);
    }
  });

  test('stopTray 在未启动时是幂等的', () => {
    assert.deepEqual(tray.stopTray(), { ok: true, already: true });
  });
});
