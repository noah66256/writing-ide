import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { adjustUserPoints } from "./billing.js";
import { loadDb, updateDb, type RechargeConfig, type RechargeOrder, type RechargeProduct } from "./db.js";
import {
  createJsapiPrepay,
  decryptWxPayResourceToJson,
  exchangeMpOauthCodeForOpenid,
  generateJsapiPayParams,
  getWxPayRuntimeFromEnv,
  verifyWxPayNotifySignature,
} from "./wxpay.js";

function nowIso() {
  return new Date().toISOString();
}

function addMinutesIso(iso: string, minutes: number) {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return nowIso();
  return new Date(t + minutes * 60 * 1000).toISOString();
}

function isExpired(expiresAtIso: string) {
  const t = new Date(expiresAtIso).getTime();
  if (Number.isNaN(t)) return true;
  return t < Date.now();
}

function defaultRechargeConfig(): RechargeConfig {
  const t = nowIso();
  return {
    // 商业默认：4 倍定价（1 元=250 积分）；分组可在 B 端热调整。
    pointsPerCnyByGroup: { normal: 250, vip: 500 },
    defaultGroup: "normal",
    giftEnabled: false,
    giftMultiplierByGroup: { normal: 0, vip: 0 },
    giftDefaultMultiplier: 0,
    updatedBy: null,
    createdAt: t,
    updatedAt: t,
  };
}

function defaultRechargeProducts(): RechargeProduct[] {
  const t = nowIso();
  const mk = (args: { sku: string; name: string; amountCent: number; originalAmountCent?: number | null }) => ({
    // 关键：id 必须稳定，否则 products 列表请求与创建订单时的 defaults 不一致会导致 PRODUCT_NOT_FOUND。
    // 用 sku 作为稳定 id（仍允许未来在 DB 中自定义 products）。
    id: args.sku,
    sku: args.sku,
    name: args.name,
    amountCent: args.amountCent,
    pointsFixed: null,
    originalAmountCent: args.originalAmountCent ?? null,
    status: "active" as const,
    createdAt: t,
    updatedAt: t,
  });
  return [
    mk({ sku: "points_100_cny", name: "充值 ¥100", amountCent: 10_000, originalAmountCent: null }),
    mk({ sku: "points_200_cny", name: "充值 ¥200", amountCent: 20_000, originalAmountCent: null }),
    mk({ sku: "points_500_cny", name: "充值 ¥500", amountCent: 50_000, originalAmountCent: null }),
  ];
}

function pickGroup(args: { userBillingGroup: string | null; cfg: RechargeConfig }): { group: string; pointsPerCny: number; giftMultiplier: number } {
  const cfg = args.cfg;
  const g0 = String(args.userBillingGroup ?? "").trim();
  const g = g0 || cfg.defaultGroup || "normal";
  const n1 = Number(cfg.pointsPerCnyByGroup?.[g]);
  const n2 = Number(cfg.pointsPerCnyByGroup?.[cfg.defaultGroup || "normal"]);
  const pointsPerCny = Number.isFinite(n1) && n1 > 0 ? Math.floor(n1) : Number.isFinite(n2) && n2 > 0 ? Math.floor(n2) : 1000;
  const gift = cfg.giftEnabled
    ? (() => {
        const m1 = Number((cfg as any).giftMultiplierByGroup?.[g]);
        const m2 = Number((cfg as any).giftMultiplierByGroup?.[cfg.defaultGroup || "normal"]);
        const m3 = Number((cfg as any).giftDefaultMultiplier);
        const v = Number.isFinite(m1) && m1 >= 0 ? m1 : Number.isFinite(m2) && m2 >= 0 ? m2 : Number.isFinite(m3) && m3 >= 0 ? m3 : 0;
        return Math.max(0, Math.min(10, v));
      })()
    : 0;
  return { group: g, pointsPerCny, giftMultiplier: gift };
}

function computePointsToCredit(args: { product: RechargeProduct; pointsPerCny: number; giftMultiplier: number }) {
  if (Number.isFinite(args.product.pointsFixed) && (args.product.pointsFixed ?? 0) > 0) {
    const base = Math.floor(Number(args.product.pointsFixed));
    const gift = Math.max(0, Math.min(10, Number(args.giftMultiplier) || 0));
    return Math.max(0, base + Math.floor(base * gift));
  }
  const amountCent = Math.max(0, Math.floor(Number(args.product.amountCent) || 0));
  const pointsPerCny = Math.max(1, Math.floor(Number(args.pointsPerCny) || 1000));
  const base = Math.max(0, Math.floor((amountCent * pointsPerCny) / 100));
  const gift = Math.max(0, Math.min(10, Number(args.giftMultiplier) || 0));
  return Math.max(0, base + Math.floor(base * gift));
}

function makeOutTradeNo(): string {
  // 微信限制：商户订单号 out_trade_no ≤ 32，且只能含字母数字下划线等。
  // 这里用短 UUID（去掉 -）并加前缀，控制在 32 内。
  const u = randomUUID().replaceAll("-", "");
  return `wr${u}`.slice(0, 32);
}

function makePayLinkToken(): string {
  return randomUUID().replaceAll("-", "");
}

function escapeHtml(s: string) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeJsonInHtml(obj: unknown) {
  return JSON.stringify(obj).replace(/</g, "\\u003c");
}

export function registerRechargeRoutes(fastify: FastifyInstance) {
  // ======== Recharge: Products / Orders ========

  fastify.get(
    "/api/recharge/products",
    { preHandler: (fastify as any).authenticate },
    async (request: any) => {
      const userId = String(request.user?.sub ?? "").trim();
      const db0 = await loadDb();
      const me = db0.users.find((u) => u.id === userId);

      // 关键：确保默认 products 会写入 DB（否则每次 defaultRechargeProducts() 生成的 id 不一致，会导致下单时 PRODUCT_NOT_FOUND）。
      const ensured = !db0.rechargeConfig || !Array.isArray(db0.rechargeProducts) || db0.rechargeProducts.length === 0
        ? await updateDb((db) => {
            if (!db.rechargeConfig) db.rechargeConfig = defaultRechargeConfig();
            if (!Array.isArray(db.rechargeProducts) || db.rechargeProducts.length === 0) db.rechargeProducts = defaultRechargeProducts();
            return { cfg: db.rechargeConfig!, productsAll: db.rechargeProducts! };
          })
        : { cfg: db0.rechargeConfig!, productsAll: db0.rechargeProducts! };

      const cfg = ensured.cfg;
      const { group, pointsPerCny, giftMultiplier } = pickGroup({ userBillingGroup: (me as any)?.billingGroup ?? null, cfg });
      const productsAll = ensured.productsAll;
      const products = productsAll
        .filter((p) => p && p.status === "active")
        .map((p) => ({
          id: p.id,
          sku: p.sku,
          name: p.name,
          amountCent: p.amountCent,
          originalAmountCent: p.originalAmountCent,
          points: computePointsToCredit({ product: p, pointsPerCny, giftMultiplier }),
        }));

      return { ok: true, billingGroup: group, pointsPerCny, giftEnabled: Boolean((cfg as any).giftEnabled), giftMultiplier, products };
    },
  );

  fastify.post(
    "/api/recharge/orders",
    { preHandler: (fastify as any).authenticate },
    async (request: any, reply: any) => {
      const rt = getWxPayRuntimeFromEnv();
      if (!rt.enabled) return reply.code(400).send({ error: "WX_PAY_DISABLED" });
      if (!rt.payBaseUrl) return reply.code(500).send({ error: "PAY_BASE_URL_NOT_SET" });

      const bodySchema = z.object({ productId: z.string().min(1) });
      const { productId } = bodySchema.parse(request.body ?? {});

      const userId = String(request.user?.sub ?? "").trim();
      if (!userId) return reply.code(401).send({ error: "UNAUTHORIZED" });
      const jwtRole = request.user?.role === "admin" ? "admin" : "user";
      const jwtEmail = request.user?.email ? String(request.user.email).trim().toLowerCase() : null;
      const jwtPhone = request.user?.phone ? String(request.user.phone).trim() : null;

      const createdAt = nowIso();
      const expireAt = addMinutesIso(createdAt, 30);

      const ret: { ok: true; order: RechargeOrder; payUrl: string } | { ok: false; error: string } = await updateDb((db) => {
        // 自愈：某些情况下 token 仍有效但 DB 发生过“换库/迁移”（例如 db.json 路径调整），会导致 userId 在新库不存在。
        // 为保证充值闭环可用：在此处按 JWT payload 补一条用户记录（id 固定为 sub），后续入账/查余额都能对齐同一个 sub。
        let user = db.users.find((u) => u.id === userId);
        if (!user) {
          user = {
            id: userId,
            email: jwtEmail,
            phone: jwtPhone,
            role: jwtRole,
            pointsBalance: 0,
            billingGroup: null,
            createdAt: nowIso(),
          } as any;
          db.users.push(user as any);
        }

        // ensure defaults (best-effort)
        if (!db.rechargeConfig) db.rechargeConfig = defaultRechargeConfig();
        if (!Array.isArray(db.rechargeProducts) || !db.rechargeProducts.length) db.rechargeProducts = defaultRechargeProducts();
        if (!Array.isArray(db.rechargeOrders)) db.rechargeOrders = [];

        const cfg = db.rechargeConfig!;
        const products = db.rechargeProducts!;
        const product = products.find((p) => p.id === productId && p.status === "active");
        if (!product) return { ok: false, error: "PRODUCT_NOT_FOUND" };

        const { group, pointsPerCny, giftMultiplier } = pickGroup({ userBillingGroup: (user as any)?.billingGroup ?? null, cfg });
        const pointsToCredit = computePointsToCredit({ product, pointsPerCny, giftMultiplier });
        if (pointsToCredit <= 0) return { ok: false, error: "POINTS_CALC_FAILED" };

        const order: RechargeOrder = {
          id: randomUUID(),
          userId,
          productId: product.id,
          productSnapshot: {
            sku: product.sku,
            name: product.name,
            amountCent: product.amountCent,
            pointsFixed: product.pointsFixed,
            originalAmountCent: product.originalAmountCent,
          },
          amountCent: product.amountCent,
          billingGroup: group,
          pointsPerCny,
          pointsToCredit,
          status: "created",
          outTradeNo: makeOutTradeNo(),
          transactionId: null,
          payerOpenid: null,
          payLinkToken: makePayLinkToken(),
          payLinkCreatedAt: createdAt,
          paidAt: null,
          expireAt,
          createdAt,
          updatedAt: createdAt,
        };

        db.rechargeOrders!.push(order);
        const payUrl = `${rt.payBaseUrl}/pay/${encodeURIComponent(order.payLinkToken)}`;
        return { ok: true, order, payUrl };
      });

      if (!ret.ok) return reply.code(400).send({ error: ret.error });
      return reply.send({
        ok: true,
        orderId: ret.order.id,
        amountCent: ret.order.amountCent,
        pointsToCredit: ret.order.pointsToCredit,
        expireAt: ret.order.expireAt,
        payUrl: ret.payUrl,
      });
    },
  );

  fastify.get(
    "/api/recharge/orders/:id/pay-status",
    { preHandler: (fastify as any).authenticate },
    async (request: any, reply: any) => {
      const paramsSchema = z.object({ id: z.string().min(1) });
      const { id } = paramsSchema.parse(request.params ?? {});
      const userId = String(request.user?.sub ?? "").trim();
      if (!userId) return reply.code(401).send({ error: "UNAUTHORIZED" });

      const db = await loadDb();
      const orders = Array.isArray(db.rechargeOrders) ? db.rechargeOrders : [];
      const o = orders.find((x) => x.id === id && x.userId === userId);
      if (!o) return reply.code(404).send({ error: "ORDER_NOT_FOUND" });
      const expired = isExpired(o.expireAt);
      const status = expired && o.status === "created" ? "closed" : o.status;
      return { ok: true, paid: status === "paid", status, expireAt: o.expireAt, pointsToCredit: o.pointsToCredit };
    },
  );

  // ======== Pay landing (公众号 H5(JSAPI)) ========

  fastify.get("/pay/:token", async (request: any, reply: any) => {
    const rt = getWxPayRuntimeFromEnv();
    if (!rt.enabled) return reply.code(503).type("text/plain; charset=utf-8").send("支付未开启");
    const token = String(request.params?.token ?? "").trim();
    if (!token) return reply.code(400).type("text/plain; charset=utf-8").send("bad request");

    const db = await loadDb();
    const orders = Array.isArray(db.rechargeOrders) ? db.rechargeOrders : [];
    const order = orders.find((o) => o.payLinkToken === token) as RechargeOrder | undefined;
    if (!order) return reply.code(404).type("text/plain; charset=utf-8").send("链接无效或已过期");
    if (order.status !== "created") {
      return reply
        .code(200)
        .type("text/plain; charset=utf-8")
        .send(`订单当前状态：${escapeHtml(order.status)}。如已支付请回到客户端刷新积分。`);
    }
    if (isExpired(order.expireAt)) {
      return reply.code(200).type("text/plain; charset=utf-8").send("订单已过期，请回到客户端重新发起充值。");
    }

    const ua = String(request.headers?.["user-agent"] ?? "").toLowerCase();
    const inWeChat = ua.includes("micromessenger");
    if (!inWeChat) {
      const html = `<!doctype html>
<html lang="zh-CN"><head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>写作IDE充值</title>
  <style>
    body { margin:0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial; background:#f6f7fb; color:#1f1f1f; }
    .wrap { max-width: 560px; margin: 0 auto; padding: 24px 16px; }
    .card { background:#fff; border-radius: 12px; padding: 16px; box-shadow: 0 8px 24px rgba(0,0,0,.06); }
    .title { font-size: 18px; font-weight: 700; margin: 0 0 8px; }
    .row { font-size: 14px; line-height: 20px; color:#555; margin: 6px 0; word-break: break-all; }
    .muted { font-size: 12px; color:#888; margin-top: 12px; line-height: 18px; }
  </style>
</head><body>
  <div class="wrap"><div class="card">
    <p class="title">请用微信打开该页面</p>
    <p class="row">该充值链接需要在微信内拉起支付（JSAPI）。</p>
    <p class="muted">你可以：复制链接到微信聊天里打开，或使用微信扫一扫二维码。</p>
  </div></div>
</body></html>`;
      return reply.code(200).type("text/html; charset=utf-8").send(html);
    }

    const code = String(request.query?.code ?? "").trim();
    const state = String(request.query?.state ?? "").trim();

    // OAuth：没有 code 先跳转去拿 openid
    if (!code) {
      const redirectUri = `${rt.payBaseUrl}/pay/${encodeURIComponent(token)}`;
      const scope = "snsapi_base";
      const oauthUrl = `https://open.weixin.qq.com/connect/oauth2/authorize?appid=${encodeURIComponent(
        rt.mpAppId,
      )}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scope}&state=${encodeURIComponent(token)}#wechat_redirect`;
      return reply.redirect(oauthUrl);
    }
    if (state && state !== token) {
      return reply.code(400).type("text/plain; charset=utf-8").send("state mismatch");
    }

    try {
      const openid = await exchangeMpOauthCodeForOpenid({ code, rt });
      const prepay = await createJsapiPrepay({
        rt,
        appId: rt.mpAppId,
        openid,
        description: order.productSnapshot?.name || "写作IDE充值",
        outTradeNo: order.outTradeNo,
        amountCent: order.amountCent,
      });
      const payParams = generateJsapiPayParams({ rt, appId: rt.mpAppId, prepayId: prepay.prepayId });

      const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>写作IDE充值</title>
  <style>
    body { margin:0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial; background:#f6f7fb; color:#1f1f1f; }
    .wrap { max-width: 560px; margin: 0 auto; padding: 24px 16px; }
    .card { background:#fff; border-radius: 12px; padding: 16px; box-shadow: 0 8px 24px rgba(0,0,0,.06); }
    .title { font-size: 18px; font-weight: 700; margin: 0 0 8px; }
    .row { font-size: 14px; line-height: 20px; color:#555; margin: 6px 0; word-break: break-all; }
    .btn { width: 100%; border: none; border-radius: 10px; padding: 14px 12px; font-size: 16px; font-weight: 600; background:#ff8a2a; color:#fff; margin-top: 14px; }
    .muted { font-size: 12px; color:#888; margin-top: 12px; line-height: 18px; }
    .err { color:#d4380d; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <p class="title">正在拉起微信支付…</p>
      <p class="row">商品：${escapeHtml(order.productSnapshot?.name || "充值")}</p>
      <p class="row">金额：¥${(Number(order.amountCent || 0) / 100).toFixed(2)}</p>
      <button class="btn" id="payBtn">立即支付</button>
      <p class="muted" id="hint">支付完成后返回客户端刷新积分。</p>
      <p class="muted err" id="err" style="display:none;"></p>
    </div>
  </div>
  <script>
    (function(){
      var payParams = ${safeJsonInHtml(payParams)};
      function showErr(msg){
        var el = document.getElementById('err');
        el.style.display = 'block';
        el.textContent = msg || '支付失败';
      }
      function invokePay(){
        if (!window.WeixinJSBridge) {
          showErr('未检测到微信 JSBridge，请在微信内打开后重试。');
          return;
        }
        window.WeixinJSBridge.invoke('getBrandWCPayRequest', payParams, function(res){
          var msg = (res && (res.err_msg || res.errMsg)) || '';
          if (msg === 'get_brand_wcpay_request:ok') {
            document.getElementById('hint').textContent = '支付成功！请返回客户端刷新积分。';
            return;
          }
          if (msg === 'get_brand_wcpay_request:cancel') {
            showErr('已取消支付');
            return;
          }
          showErr('支付失败：' + msg);
        });
      }
      document.getElementById('payBtn').addEventListener('click', function(){ invokePay(); });
      if (typeof window.WeixinJSBridge === 'undefined') {
        if (document.addEventListener) {
          document.addEventListener('WeixinJSBridgeReady', invokePay, false);
        } else if (document.attachEvent) {
          document.attachEvent('WeixinJSBridgeReady', invokePay);
          document.attachEvent('onWeixinJSBridgeReady', invokePay);
        }
      } else {
        invokePay();
      }
    })();
  </script>
</body>
</html>`;
      return reply.code(200).type("text/html; charset=utf-8").send(html);
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      return reply.code(500).type("text/plain; charset=utf-8").send(msg);
    }
  });

  // ======== WeChat Pay notify ========

  fastify.post("/api/payments/wxpay/notify", async (request: any, reply: any) => {
    const rt = getWxPayRuntimeFromEnv();
    const rawBodyBuf: Buffer | null = (request as any).rawBody && Buffer.isBuffer((request as any).rawBody) ? (request as any).rawBody : null;
    const rawBody = rawBodyBuf ? rawBodyBuf.toString("utf8") : JSON.stringify(request.body ?? {});

    const sig = verifyWxPayNotifySignature({ rt, headers: request.headers ?? {}, rawBody });
    if (!sig.ok) {
      // 验签失败：按微信要求返回 FAIL（微信会重试）
      return reply.code(200).send({ code: "FAIL", message: "签名验证失败" });
    }

    const body = request.body ?? {};
    const resource = body?.resource;
    if (!resource || typeof resource !== "object") return reply.code(200).send({ code: "FAIL", message: "缺少 resource" });

    let decrypted: any = null;
    try {
      decrypted = decryptWxPayResourceToJson({
        rt,
        resource: {
          ciphertext: String((resource as any).ciphertext ?? ""),
          associated_data: String((resource as any).associated_data ?? ""),
          nonce: String((resource as any).nonce ?? ""),
        },
      });
    } catch {
      return reply.code(200).send({ code: "FAIL", message: "解密失败" });
    }

    const outTradeNo = String(decrypted?.out_trade_no ?? "").trim();
    const transactionId = String(decrypted?.transaction_id ?? "").trim();
    const tradeState = String(decrypted?.trade_state ?? "").trim();
    const payerOpenid = String(decrypted?.payer?.openid ?? "").trim();
    const amountTotal = Number(decrypted?.amount?.total);

    if (!outTradeNo || !transactionId) return reply.code(200).send({ code: "FAIL", message: "缺少交易字段" });
    if (tradeState !== "SUCCESS") return reply.code(200).send({ code: "SUCCESS", message: "成功" });

    try {
      const ret = await updateDb((db) => {
        const orders = Array.isArray(db.rechargeOrders) ? db.rechargeOrders : [];
        const order = orders.find((o) => o.outTradeNo === outTradeNo) as RechargeOrder | undefined;
        if (!order) {
          return { ok: true, ignored: true };
        }
        if (order.status === "paid") {
          return { ok: true, ignored: true };
        }
        if (Number.isFinite(amountTotal) && Math.floor(amountTotal) !== Math.floor(Number(order.amountCent || 0))) {
          return { ok: false, error: "AMOUNT_MISMATCH" as const };
        }
        if (isExpired(order.expireAt)) {
          order.status = "closed";
          order.updatedAt = nowIso();
          return { ok: false, error: "ORDER_EXPIRED" as const };
        }

        order.status = "paid";
        order.transactionId = transactionId;
        order.payerOpenid = payerOpenid || null;
        order.paidAt = nowIso();
        order.updatedAt = nowIso();

        adjustUserPoints({
          db,
          userId: order.userId,
          delta: Math.max(0, Math.floor(Number(order.pointsToCredit) || 0)),
          type: "recharge",
          reason: `wxpay_recharge:${order.id}`,
        });

        return { ok: true, credited: true };
      });

      if (!ret.ok) {
        // 失败返回 FAIL 让微信重试（避免丢单）
        return reply.code(200).send({ code: "FAIL", message: "处理失败" });
      }

      return reply.code(200).send({ code: "SUCCESS", message: "成功" });
    } catch {
      return reply.code(200).send({ code: "FAIL", message: "处理失败" });
    }
  });
}

