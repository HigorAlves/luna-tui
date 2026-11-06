// Files the host reads from a folder a container writes (`/out`, `/out/bundles`). The container is not trusted, so a file there may be a
// link to a host file or a FIFO that blocks the first reader forever (and with it the whole machine process): each is opened without
// following a link and without blocking, and only what the open file turns out to be (a regular file, within its cap) is read.
import { constants } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";

const FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

async function openRegular(path: string): Promise<{ handle: FileHandle; size: number }> {
  // A file that is not there keeps its own error (ENOENT), which callers read as "not written yet".
  const info = await lstat(path);
  if (!info.isFile()) throw new Error(`${path} is not a regular file`);
  const handle = await open(path, FLAGS);
  try {
    // What was opened is what was checked: a file swapped in between the lstat and the open is refused here.
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error(`${path} is not a regular file`);
    return { handle, size: opened.size };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** The text of a regular file of at most `maxBytes`; throws for a link, a FIFO or anything else, and for a file that is too big. */
export async function readRegularFile(path: string, maxBytes: number): Promise<string> {
  const { handle, size } = await openRegular(path);
  try {
    if (size > maxBytes) throw new Error(`${path} is ${size} bytes, over the ${maxBytes} byte cap`);
    const buffer = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const { bytesRead } = await handle.read(buffer, read, size - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** Copies a regular file to `to` through the open file, never following a link and never blocking on a FIFO. */
export async function copyRegularFile(from: string, to: string): Promise<void> {
  const { handle } = await openRegular(from);
  try {
    await pipeline(handle.createReadStream({ autoClose: false, start: 0 }), createWriteStream(to));
  } finally {
    await handle.close();
  }
}

/** The sha256 of a regular file of at most `maxBytes`, streamed from the open file (never read whole); null for a file over the cap. Throws for a link, a FIFO or anything else. */
export async function hashRegularFile(path: string, maxBytes: number): Promise<string | null> {
  const { handle, size } = await openRegular(path);
  try {
    if (size > maxBytes) return null;
    const hash = createHash("sha256");
    // Only the size that was checked is read: a file that grows after the open is not hashed past the cap.
    if (size > 0) for await (const chunk of handle.createReadStream({ autoClose: false, start: 0, end: size - 1 })) hash.update(chunk as Buffer);
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

/** The bytes of a regular file of at most `maxBytes`; throws for a link, a FIFO or anything else, and for a file that is too big. */
export async function readRegularBytes(path: string, maxBytes: number): Promise<Buffer> {
  const { handle, size } = await openRegular(path);
  try {
    if (size > maxBytes) throw new Error(`${path} is ${size} bytes, over the ${maxBytes} byte cap`);
    const buffer = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const { bytesRead } = await handle.read(buffer, read, size - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return buffer.subarray(0, read);
  } finally {
    await handle.close();
  }
}
