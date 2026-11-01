import { copyFileSync, existsSync, mkdirSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

// Node 25 的 fs.rmSync / cpSync 在 Windows 中文路徑會整個程序崩潰，自己遞迴處理
export function removeDir(dir) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) removeDir(p);
    else unlinkSync(p);
  }
  rmdirSync(dir);
}

export function copyDir(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    if (e.isDirectory()) copyDir(join(src, e.name), join(dst, e.name));
    else copyFileSync(join(src, e.name), join(dst, e.name));
  }
}
