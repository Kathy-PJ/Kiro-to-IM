/**
 * Resource Store — SHA256 dedup resource storage with auto-cleanup.
 *
 * Translates acp-link's resource.rs:
 *   - Download image/file from IM → SHA256 hash → save locally
 *   - Dedup: same content → same file (no re-download)
 *   - Auto-cleanup: remove files older than retention days
 *   - Returns file:// URI for ACP resource_link blocks
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { KTI_HOME } from './config.js';

const DATA_DIR = path.join(KTI_HOME, 'data', 'resources');

function hexSha256(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function extFromName(name: string): string {
  const ext = path.extname(name).replace(/^\./, '');
  return ext || 'bin';
}

export class ResourceStore {
  private saveDir: string;

  constructor(saveDir?: string) {
    this.saveDir = saveDir || DATA_DIR;
    fs.mkdirSync(this.saveDir, { recursive: true });
  }

  /**
   * Save resource data to local store with SHA256 dedup.
   * Returns the local file path.
   */
  saveResource(data: Buffer, originalName: string): string {
    const hash = hexSha256(data);
    const ext = extFromName(originalName);
    const filename = `${hash}.${ext}`;
    const filePath = path.join(this.saveDir, filename);

    if (fs.existsSync(filePath)) {
      // Refresh mtime to prevent premature cleanup
      try {
        const now = new Date();
        fs.utimesSync(filePath, now, now);
      } catch { /* non-fatal */ }
      return filePath;
    }

    fs.writeFileSync(filePath, data);
    console.log(`[resource-store] Saved: ${filename} (${data.length} bytes)`);
    return filePath;
  }

  /**
   * Download a resource via an adapter, save locally, return path.
   */
  async downloadAndSave(
    adapter: { downloadResource(messageId: string, fileKey: string, type: 'image' | 'file'): Promise<Buffer> },
    messageId: string,
    fileKey: string,
    type: 'image' | 'file',
    originalName: string,
  ): Promise<string> {
    const data = await adapter.downloadResource(messageId, fileKey, type);
    return this.saveResource(data, originalName);
  }

  /**
   * Convert local path to file:// URI.
   */
  static toFileUri(filePath: string): string {
    return `file://${path.resolve(filePath)}`;
  }

  /**
   * Cleanup expired resource files.
   * Returns number of files removed.
   */
  cleanupExpired(retentionDays: number): number {
    const ttlMs = retentionDays * 24 * 60 * 60 * 1000;
    const now = Date.now();
    let removed = 0;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.saveDir, { withFileTypes: true });
    } catch {
      return 0;
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const filePath = path.join(this.saveDir, entry.name);
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > ttlMs) {
          fs.unlinkSync(filePath);
          removed++;
        }
      } catch { /* skip */ }
    }

    if (removed > 0) {
      console.log(`[resource-store] Cleanup: removed ${removed} expired files`);
    }
    return removed;
  }
}
