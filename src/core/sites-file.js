import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

/**
 * 網頁新增的網站設定存在 sites.json（陣列），本機版和雲端版（GitHub）共用：
 * [{ id, name, enabled, listUrl, linkPattern?, maxPages, fetchDetail, volatileFields, ... }]
 */
export function readSitesFile(file) {
  if (!existsSync(file)) return [];
  const list = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  return Array.isArray(list) ? list : [];
}

export function writeSitesFile(file, list) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n');
  renameSync(tmp, file);
}
