// GitHub API（家裡電腦推送 BeClass 資料用）：權杖只放在 Authorization 標頭，不出現在指令列或 git 設定裡

/** owner/repo 格式檢查，避免把權杖送到奇怪的路徑 */
export const isRepoName = (s) => /^[\w.-]+\/[\w.-]+$/.test(s ?? '');

export function githubClient({ repo, token, fetchImpl = fetch }) {
  if (!isRepoName(repo)) throw new Error(`GH_REPO 格式錯誤（要像 tzy0303/Crawler）：${repo}`);
  if (!token) throw new Error('沒有設定 GH_SYNC_TOKEN');
  const call = async (method, path, body) => {
    const r = await fetchImpl(`https://api.github.com/repos/${repo}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(120_000),
    });
    if (!r.ok) {
      const err = new Error(`GitHub ${r.status} ${method} ${path}：${(await r.json().catch(() => ({}))).message ?? ''}`);
      err.status = r.status;
      throw err;
    }
    return r.status === 204 ? {} : r.json();
  };

  return {
    /** 分支只放一個檔案、只留最新一份（沒有上一個 commit，強制覆蓋），回傳 commit sha */
    async replaceBranch(branch, path, bytes, message) {
      const blob = await call('POST', '/git/blobs', { content: Buffer.from(bytes).toString('base64'), encoding: 'base64' });
      const tree = await call('POST', '/git/trees', { tree: [{ path, mode: '100644', type: 'blob', sha: blob.sha }] });
      const commit = await call('POST', '/git/commits', { message, tree: tree.sha, parents: [] });
      try {
        await call('PATCH', `/git/refs/heads/${branch}`, { sha: commit.sha, force: true });
      } catch (err) {
        if (err.status !== 422 && err.status !== 404) throw err; // 分支還不存在
        await call('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha: commit.sha });
      }
      return commit.sha;
    },
    dispatch(workflow, ref, inputs = {}) {
      return call('POST', `/actions/workflows/${workflow}/dispatches`, { ref, inputs });
    },
  };
}
