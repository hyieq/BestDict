const REPOSITORY = 'hyieq/BestDict';
const RELEASES_URL = `https://github.com/${REPOSITORY}/releases/latest`;
const API_URL = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;

function versionParts(value) {
  const match = typeof value === 'string' && value.match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  if (!match) throw new Error('更新信息无效，请稍后重试。');
  return match.slice(1).map(part => BigInt(part));
}

function newerVersion(candidate, current) {
  const next = versionParts(candidate), previous = versionParts(current);
  for (let i = 0; i < next.length; i++) if (next[i] !== previous[i]) return next[i] > previous[i];
  return false;
}

class UpdateService {
  constructor({ version, platform = process.platform, arch = process.arch, fetchRelease = fetch,
    openExternal, now = Date.now, timeout = 12000, cacheDuration = 300000 }) {
    versionParts(version);
    Object.assign(this, { version, platform, arch, fetchRelease, openExternal, now, timeout, cacheDuration });
    this.result = null;
    this.selection = null;
    this.pending = null;
    this.checkedAt = 0;
  }

  check() {
    if (this.pending) return this.pending;
    if (this.result && this.now() - this.checkedAt < this.cacheDuration) return Promise.resolve(this.result);
    this.pending = this.request().finally(() => { this.pending = null; });
    return this.pending;
  }

  async request() {
    this.result = null;
    this.selection = null;
    let response;
    try {
      response = await this.fetchRelease(API_URL, { signal: AbortSignal.timeout(this.timeout),
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `BestDict/${this.version}` } });
      if (response.status === 403 || response.status === 429) throw new Error('GitHub 暂时限制了检查请求，请稍后重试。');
      if (response.status === 404) return this.remember({ state: 'unpublished', currentVersion: this.version, latestVersion: null });
      if (!response.ok) throw new Error('暂时无法连接 GitHub，请稍后重试。');
      const release = await response.json();
      if (!release || typeof release !== 'object' || release.draft !== false || release.prerelease !== false || !Array.isArray(release.assets)) throw new Error('更新信息无效，请稍后重试。');
      versionParts(release.tag_name);
      const version = release.tag_name.replace(/^v/, '');
      const tag = encodeURIComponent(release.tag_name);
      const releaseUrl = `https://github.com/${REPOSITORY}/releases/tag/${tag}`;
      const names = this.platform === 'win32' && this.arch === 'x64' ? [`BestDict-${version}-x64-Setup.exe`] :
        this.platform === 'darwin' && ['arm64', 'x64'].includes(this.arch) ? [`BestDict-${version}-macOS-${this.arch}.dmg`, `BestDict-${version}-macOS-${this.arch}.zip`] : [];
      const asset = names.map(name => release.assets.find(item => item && item.name === name && item.state === 'uploaded' && Number.isSafeInteger(item.size) && item.size > 0)).find(Boolean);
      // Build links from the fixed repository and expected asset names. Never
      // pass an arbitrary URL from the renderer or release JSON to the shell.
      this.selection = { releaseUrl, downloadUrl: asset ? `https://github.com/${REPOSITORY}/releases/download/${tag}/${encodeURIComponent(asset.name)}` : null };
      const state = !newerVersion(version, this.version) ? 'latest' : asset ? 'available' : 'unavailable';
      return this.remember({ state, currentVersion: this.version, latestVersion: version });
    } catch (error) {
      if (error.name === 'TimeoutError' || error.name === 'AbortError') throw new Error('检查更新超时，请重试。');
      if (error instanceof SyntaxError) throw new Error('更新信息无效，请稍后重试。');
      if (error.message === 'GitHub 暂时限制了检查请求，请稍后重试。' || error.message === '更新信息无效，请稍后重试。' || error.message === '暂时无法连接 GitHub，请稍后重试。') throw error;
      throw new Error('检查更新失败，请检查网络后重试。');
    }
  }

  remember(result) {
    this.result = Object.freeze(result);
    this.checkedAt = this.now();
    return this.result;
  }

  open(target) {
    if (target === 'release') return this.openExternal(this.selection?.releaseUrl || RELEASES_URL);
    if (target === 'download' && this.result?.state === 'available' && this.selection?.downloadUrl) return this.openExternal(this.selection.downloadUrl);
    throw new Error('没有适用于当前系统的更新安装包。');
  }
}

module.exports = { UpdateService, newerVersion };
