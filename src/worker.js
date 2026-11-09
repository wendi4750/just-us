const J = (o, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { "content-type": "application/json" },
  });

let ready;

// Google Drive bridge via Apps Script Web App
const DRIVE_LIMIT = 4 * 1024 * 1024; // 4 MB

function bytesToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + 0x8000, bytes.length))
    );
  }
  return btoa(binary);
}

function base64ToBytes(s) {
  const binary = atob(s);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function driveCall(env, payload) {
  if (!env.DRIVE_URL || !env.DRIVE_KEY) {
    throw new Error("Google Drive is not configured (missing DRIVE_URL or DRIVE_KEY)");
  }

  const r = await fetch(env.DRIVE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, key: env.DRIVE_KEY }),
  });

  let j;
  try {
    j = await r.json();
  } catch {
    throw new Error("Apps Script returned non-JSON (check deployment /exec URL)");
  }

  if (!r.ok || !j.ok) {
    throw new Error(j.error || "Google Drive request failed");
  }
  return j;
}

async function driveUpload(env, buf, name, mime) {
  if (buf.byteLength > DRIVE_LIMIT) {
    throw new Error("File exceeds the 4 MB limit");
  }
  const j = await driveCall(env, {
    action: "upload",
    name,
    mime,
    data: bytesToBase64(buf),
  });
  return j.id;
}

async function put(env, c, i, d, del) {
  await env.DB.prepare(
    "INSERT INTO docs(c,i,d,u,del) VALUES(?1,?2,?3,(SELECT COALESCE(MAX(u),0)+1 FROM docs),?4) ON CONFLICT(c,i) DO UPDATE SET d=?3,del=?4,u=(SELECT COALESCE(MAX(u),0)+1 FROM docs)"
  )
    .bind(c, i, d, del)
    .run();
}

// finds the first video / image URL anywhere in a provider's JSON reply
function pick(o) {
  let v, v2, im, cap;
  (function w(x, k) {
    if (typeof x === "string") {
      if (!cap && /^(caption|title|text|description)$/i.test(k || "") && x.length > 2) cap = x;
      if (!/^https?:\/\//.test(x)) return;
      const isImg = /\.(jpe?g|png|webp)(\?|&|$)/i.test(x);
      if (!v && (/\.mp4(\?|&|$)/i.test(x) || (/video|download/i.test(k || "") && !isImg))) v = x;
      else if (
        !v2 &&
        /^(url|link|src|media|file|hd|sd)$/i.test(k || "") &&
        !isImg &&
        !/^https?:\/\/(www\.)?instagram\.com\//i.test(x)
      )
        v2 = x;
      else if (!im && isImg) im = x;
    } else if (x && typeof x === "object") {
      for (const a in x) w(x[a], a);
    }
  })(o);
  return { video: v || v2, image: im, cap };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;

    // Static assets
    if (!p.startsWith("/api/") && !p.startsWith("/tg/") && env.ASSETS) {
      return env.ASSETS.fetch(req);
    }

    // Ensure D1 table
    ready =
      ready ||
      env.DB.exec(
        "CREATE TABLE IF NOT EXISTS docs(c TEXT,i TEXT,d TEXT,u INTEGER,del INTEGER DEFAULT 0,PRIMARY KEY(c,i))"
      );
    await ready;

    // ---------- Telegram bot ----------
    if (p.startsWith("/tg/")) {
      if (!env.TG_SECRET || p.slice(4) !== env.TG_SECRET || req.method !== "POST") {
        return J({ error: "x" }, 403);
      }
      const u = await req.json();
      const m = u.message;
      if (!m) return J({ ok: 1 });
      if (env.TG_ALLOWED && !env.TG_ALLOWED.split(",").includes(String(m.from && m.from.id))) {
        return J({ ok: 1 });
      }

      const API = "https://api.telegram.org/bot" + env.TG_TOKEN;
      const say = (x) =>
        fetch(API + "/sendMessage", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: m.chat.id, text: x }),
        });

      const img = m.photo || (m.document && /image/.test(m.document.mime_type || ""));
      const f =
        m.video ||
        m.animation ||
        (m.document && /video/.test(m.document.mime_type || "") ? m.document : null) ||
        (m.photo && m.photo[m.photo.length - 1]) ||
        (img && m.document);

      if (!f) {
        await say("Forward me a video or photo and I'll put it in the app 💌");
        return J({ ok: 1 });
      }

      try {
        const fi = await (await fetch(API + "/getFile?file_id=" + f.file_id)).json();
        if (!fi.ok) {
          await say("Too big for me (20 MB max) 😢");
          return J({ ok: 1 });
        }
        const mr = await fetch(
          "https://api.telegram.org/file/bot" + env.TG_TOKEN + "/" + fi.result.file_path
        );
        const vid = !img;
        const buf = await mr.arrayBuffer();
        if (buf.byteLength > DRIVE_LIMIT) {
          await say("File exceeds the current 4 MB limit 😢");
          return J({ ok: 1 });
        }
        const key = await driveUpload(
          env,
          buf,
          vid ? "telegram-video.mp4" : "telegram-image.jpg",
          vid ? "video/mp4" : "image/jpeg"
        );
        const doc = {
          url: "",
          cap: String(m.caption || "").slice(0, 500),
          name: String((m.from && m.from.first_name) || "Telegram").slice(0, 20),
          t: Date.now(),
          media: key,
          kind: vid ? "video" : "image",
        };
        await put(env, "posts", "p" + Date.now().toString(36), JSON.stringify(doc), 0);
        await say("Added to the app ✅");
      } catch (e) {
        await say("Something went wrong: " + String(e.message || e));
      }
      return J({ ok: 1 });
    }

    // ---------- Auth for all /api/* ----------
    const roomHeader = req.headers.get("x-room") || url.searchParams.get("r");
    if (roomHeader !== env.ROOM_CODE) {
      return J({ error: "auth" }, 401);
    }

    // ---------- Sync ----------
    if (p === "/api/sync") {
      const s = +url.searchParams.get("since") || 0;
      const { results } = await env.DB.prepare(
        "SELECT c,i,d,u,del FROM docs WHERE u>?1 ORDER BY u LIMIT 500"
      )
        .bind(s)
        .all();
      return J({
        rows: results,
        max: results.length ? results[results.length - 1].u : s,
        more: results.length === 500,
      });
    }

    // ---------- Set / Del ----------
    if (p === "/api/set" || p === "/api/del") {
      const b = await req.json();
      if (!/^[a-z]{1,20}$/.test(b.c) || !/^[\w-]{1,40}$/.test(b.i)) {
        return J({ error: "bad" }, 400);
      }
      const d = p === "/api/set" ? JSON.stringify(b.d) : "{}";
      if (d.length > 30000) return J({ error: "big" }, 413);
      await put(env, b.c, b.i, d, p === "/api/del" ? 1 : 0);
      return J({ ok: 1 });
    }

    // ---------- Instagram ----------
    if (p === "/api/ig" && req.method === "POST") {
      const b = await req.json();
      if (!/^https:\/\/(www\.)?instagram\.com\//i.test(b.url || "")) {
        return J({ error: "bad url" }, 400);
      }
      try {
        let src,
          vid = true,
          cap = "";
        if (env.COBALT_URL) {
          const r = await fetch(env.COBALT_URL, {
            method: "POST",
            headers: Object.assign(
              { accept: "application/json", "content-type": "application/json" },
              env.COBALT_KEY ? { authorization: "Api-Key " + env.COBALT_KEY } : {}
            ),
            body: JSON.stringify({ url: b.url, videoQuality: "720" }),
          });
          const j = await r.json();
          if (j.status === "tunnel" || j.status === "redirect") {
            src = j.url;
            vid = !/\.(jpe?g|png|webp)$/i.test(j.filename || "");
          } else if (j.status === "picker" && j.picker && j.picker.length) {
            const x = j.picker.find((i) => i.type === "video") || j.picker[0];
            src = x.url;
            vid = x.type !== "photo";
          }
        } else if (env.IG_ENDPOINT) {
          const post = !!env.IG_BODY;
          const r = await fetch(env.IG_ENDPOINT.replace("{url}", encodeURIComponent(b.url)), {
            method: post ? "POST" : "GET",
            headers: Object.assign(
              {},
              JSON.parse(env.IG_HEADERS || "{}"),
              post ? { "content-type": "application/json" } : {}
            ),
            body: post
              ? env.IG_BODY.replace("{url}", b.url.replace(/"/g, ""))
              : undefined,
          });
          const m = pick(await r.json());
          src = m.video || m.image;
          vid = !!m.video;
          cap = m.cap || "";
        } else {
          return J({ error: "no Instagram provider configured" }, 501);
        }

        if (!src) return J({ error: "no media" }, 422);

        const mr = await fetch(src, { headers: { "user-agent": "Mozilla/5.0" } });
        if (!mr.ok) return J({ error: "download" }, 502);

        const mediaBuf = await mr.arrayBuffer();
        if (mediaBuf.byteLength > DRIVE_LIMIT) {
          return J({ error: "media exceeds 4 MB limit" }, 413);
        }

        const key = await driveUpload(
          env,
          mediaBuf,
          vid ? "instagram-video.mp4" : "instagram-image.jpg",
          vid ? "video/mp4" : "image/jpeg"
        );

        const name = String(b.name || "").slice(0, 20);
        const now = Date.now();
        const kind = vid ? "video" : "image";

        await put(
          env,
          "posts",
          "p" + now.toString(36),
          JSON.stringify({
            url: b.url,
            cap: String(b.cap || cap).slice(0, 500),
            name,
            t: now,
            media: key,
            kind,
          }),
          0
        );

        if (b.chat) {
          await put(
            env,
            "chat",
            "c" + now.toString(36),
            JSON.stringify({
              text: "",
              media: key,
              kind,
              name,
              uid: String(b.uid || "ig"),
              t: now,
            }),
            0
          );
        }

        return J({ ok: 1 });
      } catch (e) {
        return J({ error: String(e.message || e) }, 502);
      }
    }

    // ---------- Upload ----------
    if (p === "/api/up" && req.method === "POST") {
      const v = url.searchParams.get("k") === "video";
      const buf = await req.arrayBuffer();

      if (buf.byteLength > DRIVE_LIMIT) {
        return J({ error: "Current Google Drive bridge limit is 4 MB per file" }, 413);
      }

      try {
        const key = await driveUpload(
          env,
          buf,
          v ? "upload.mp4" : "upload.jpg",
          v
            ? req.headers.get("content-type") || "video/mp4"
            : req.headers.get("content-type") || "image/jpeg"
        );
        return J({ key });
      } catch (e) {
        return J({ error: String(e.message || e) }, 502);
      }
    }

    // ---------- Serve media ----------
    if (p.startsWith("/api/m/")) {
      const key = p.slice(7).split("/")[0];
      try {
        const j = await driveCall(env, { action: "get", id: key });
        const bytes = base64ToBytes(j.data);
        return new Response(bytes, {
          headers: {
            "content-type": j.mime || "application/octet-stream",
            "content-length": String(bytes.byteLength),
            "cache-control": "private, no-store",
            "x-content-type-options": "nosniff",
          },
        });
      } catch (e) {
        return new Response("File unavailable: " + String(e.message || e), { status: 404 });
      }
    }

    return J({ error: "not found" }, 404);
  },
};
