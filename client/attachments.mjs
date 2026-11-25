// Attachment storage for Studio messages: magic-byte image checks, size limits and directory containment.
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Largest single attachment the local server accepts. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** Most attachments one message may reference after de-duplication. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 8;

const ID_PATTERN = /^att-[a-zA-Z0-9-]{8,64}$/;
const EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A user-facing request failure carrying the HTTP status the route should answer with. */
function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

/**
 * Identify a supported image by its magic bytes only.
 * @param {Buffer} buffer raw file content
 * @returns {"image/png" | "image/jpeg" | "image/webp" | "image/gif" | null} detected mime type
 */
export function detectImageMime(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (buffer.length >= PNG_SIGNATURE.length && buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE))
    return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 6) {
    const signature = buffer.subarray(0, 6).toString("ascii");
    if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "image/webp";
  return null;
}

/** Store and retrieve local image attachments referenced by Studio messages. */
export class AttachmentStore {
  /**
   * @param {{ db: import("node:sqlite").DatabaseSync, home: string }} options Studio database and data directory
   */
  constructor({ db, home }) {
    this.db = db;
    this.dir = path.join(home, "attachments");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    db.exec(
      "CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY, filename TEXT, mime TEXT, size INTEGER, sha256 TEXT, path TEXT, created_at TEXT)",
    );
  }

  /**
   * Decode and persist one image attachment.
   * @param {{ dataBase64?: string, filename?: string }} input upload payload
   * @returns {{ id: string, filename: string, mime: string, size: number, url: string, createdAt: string }} public metadata
   */
  save({ dataBase64, filename } = {}) {
    if (typeof dataBase64 !== "string" || !dataBase64.trim()) throw fail("附件内容不能为空");
    const buffer = Buffer.from(dataBase64, "base64");
    if (!buffer.length) throw fail("附件内容不能为空");
    if (buffer.length > MAX_ATTACHMENT_BYTES) throw fail("附件不能超过 20 MB");
    const mime = detectImageMime(buffer);
    if (!mime) throw fail("只支持 PNG、JPEG、WebP、GIF 图片");
    const id = `att-${randomUUID()}`;
    const fallback = `image.${EXTENSIONS[mime]}`;
    const given = typeof filename === "string" && filename.trim() ? filename.trim() : fallback;
    const safeName = path.basename(given).slice(0, 200) || fallback;
    const file = path.join(this.dir, `${id}.${EXTENSIONS[mime]}`);
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const createdAt = new Date().toISOString();
    writeFileSync(file, buffer, { mode: 0o600, flag: "wx" });
    this.db
      .prepare("INSERT INTO attachments(id,filename,mime,size,sha256,path,created_at) VALUES (?,?,?,?,?,?,?)")
      .run(id, safeName, mime, buffer.length, sha256, file, createdAt);
    return { id, filename: safeName, mime, size: buffer.length, url: "/api/attachments/" + id, createdAt };
  }

  /**
   * Resolve one attachment only when its id is well formed and its file is still inside this store.
   * @param {string} id attachment id
   * @returns {Record<string, unknown> | null} stored record with an absolute path
   */
  get(id) {
    if (typeof id !== "string" || !ID_PATTERN.test(id)) return null;
    const row = this.db.prepare("SELECT * FROM attachments WHERE id=?").get(id);
    if (!row) return null;
    const file = path.resolve(row.path);
    const relative = path.relative(path.resolve(this.dir), file);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) return null;
    } catch {
      return null;
    }
    return { ...row, path: file, url: "/api/attachments/" + row.id, createdAt: row.created_at };
  }

  /**
   * Validate a message's attachment ids as a whole.
   * @param {unknown} ids attachment ids supplied by the client
   * @returns {Record<string, unknown>[]} resolved records in first-seen order
   */
  resolveIds(ids) {
    if (!Array.isArray(ids)) throw fail("附件列表格式不正确");
    if (ids.some((id) => typeof id !== "string")) throw fail("附件编号格式不正确");
    const unique = [...new Set(ids)];
    if (unique.length > MAX_ATTACHMENTS_PER_MESSAGE) throw fail("一次最多附带 8 个附件");
    return unique.map((id) => {
      const record = this.get(id);
      if (!record) throw fail("附件不存在或已失效");
      return record;
    });
  }
}