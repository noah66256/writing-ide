import crypto from "node:crypto";

export type WxPayRuntime = {
  enabled: boolean;
  verifyStrict: boolean;
  mchId: string;
  apiV3Key: string;
  serialNo: string;
  privateKey: string;
  notifyUrl: string;
  mpAppId: string;
  mpAppSecret: string;
  payBaseUrl: string;
  platformPublicKeyId: string;
  platformPublicKey: string;
};

function normStr(v: any) {
  return String(v ?? "").trim();
}

function stripTrailingSlash(url: string) {
  return String(url || "").trim().replace(/\/+$/g, "");
}

export function getWxPayRuntimeFromEnv(): WxPayRuntime {
  const enabled = normStr(process.env.WX_PAY_ENABLED ?? "").toLowerCase() === "true";
  const verifyStrict = normStr(process.env.WX_PAY_VERIFY_STRICT ?? "").toLowerCase() === "true";
  return {
    enabled,
    verifyStrict,
    mchId: normStr(process.env.WX_MCH_ID ?? ""),
    apiV3Key: normStr(process.env.WX_API_V3_KEY ?? ""),
    serialNo: normStr(process.env.WX_SERIAL_NO ?? ""),
    privateKey: normStr(process.env.WX_PRIVATE_KEY ?? ""),
    notifyUrl: normStr(process.env.WX_NOTIFY_URL ?? ""),
    mpAppId: normStr(process.env.WX_MP_APP_ID ?? ""),
    mpAppSecret: normStr(process.env.WX_MP_APP_SECRET ?? ""),
    payBaseUrl: stripTrailingSlash(normStr(process.env.PAY_BASE_URL ?? "")),
    platformPublicKeyId: normStr(process.env.WX_PAY_PLATFORM_PUBLIC_KEY_ID ?? ""),
    platformPublicKey: normStr(process.env.WX_PAY_PLATFORM_PUBLIC_KEY ?? ""),
  };
}

export function formatPrivateKey(key: string): string {
  const k = normStr(key);
  if (!k) return "";
  if (k.includes("-----BEGIN")) return k;
  return `-----BEGIN PRIVATE KEY-----\n${k}\n-----END PRIVATE KEY-----`;
}

export function formatPublicKey(key: string): string {
  const k = normStr(key);
  if (!k) return "";
  if (k.includes("-----BEGIN")) return k;
  return `-----BEGIN PUBLIC KEY-----\n${k}\n-----END PUBLIC KEY-----`;
}

export function generateNonce(length = 32): string {
  return crypto.randomBytes(length).toString("hex").slice(0, length);
}

export function signRsaSha256Base64(message: string, privateKey: string): string {
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(message);
  return sign.sign(formatPrivateKey(privateKey), "base64");
}

export function verifyRsaSha256Base64(args: { message: string; signatureBase64: string; publicKey: string }): boolean {
  try {
    const verify = crypto.createVerify("RSA-SHA256");
    verify.update(args.message);
    return verify.verify(formatPublicKey(args.publicKey), args.signatureBase64, "base64");
  } catch {
    return false;
  }
}

export function buildWxPayAuthorizationHeader(args: {
  mchId: string;
  serialNo: string;
  privateKey: string;
  method: "GET" | "POST";
  url: string;
  bodyStr: string;
}): { authorization: string; timestamp: string; nonce: string; signature: string } {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = generateNonce();
  const u = new URL(args.url);
  const urlPath = u.pathname + u.search;
  const message = `${args.method}\n${urlPath}\n${timestamp}\n${nonce}\n${args.bodyStr}\n`;
  const signature = signRsaSha256Base64(message, args.privateKey);
  const authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${args.mchId}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${args.serialNo}"`;
  return { authorization, timestamp, nonce, signature };
}

export async function wxpayRequestJson(args: {
  method: "GET" | "POST";
  url: string;
  body?: unknown;
  rt: WxPayRuntime;
}): Promise<any> {
  const bodyStr = args.body ? JSON.stringify(args.body) : "";
  const auth = buildWxPayAuthorizationHeader({
    mchId: args.rt.mchId,
    serialNo: args.rt.serialNo,
    privateKey: args.rt.privateKey,
    method: args.method,
    url: args.url,
    bodyStr,
  });
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "Accept-Language": "zh-CN",
    Authorization: auth.authorization,
  };
  const res = await fetch(args.url, {
    method: args.method,
    headers,
    ...(args.body ? { body: bodyStr } : {}),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    const msg = text && text.length < 800 ? text : `HTTP_${res.status}`;
    const err: any = new Error("WXPAY_HTTP_ERROR");
    err.detail = { status: res.status, body: msg };
    throw err;
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export async function exchangeMpOauthCodeForOpenid(args: { code: string; rt: WxPayRuntime }): Promise<string> {
  const code = normStr(args.code);
  if (!code) throw new Error("OAUTH_CODE_REQUIRED");
  const appid = args.rt.mpAppId;
  const secret = args.rt.mpAppSecret;
  if (!appid || !secret) throw new Error("WX_MP_CONFIG_MISSING");

  const url = new URL("https://api.weixin.qq.com/sns/oauth2/access_token");
  url.searchParams.set("appid", appid);
  url.searchParams.set("secret", secret);
  url.searchParams.set("code", code);
  url.searchParams.set("grant_type", "authorization_code");
  const res = await fetch(url.toString());
  const json: any = await res.json().catch(() => ({}));
  if (json?.errcode || !json?.openid) {
    const err: any = new Error("WX_MP_OAUTH_FAILED");
    err.detail = { errcode: json?.errcode, errmsg: json?.errmsg };
    throw err;
  }
  return String(json.openid);
}

export async function createJsapiPrepay(args: {
  rt: WxPayRuntime;
  appId: string;
  openid: string;
  description: string;
  outTradeNo: string;
  amountCent: number;
}): Promise<{ prepayId: string }> {
  const url = "https://api.mch.weixin.qq.com/v3/pay/transactions/jsapi";
  const body = {
    appid: normStr(args.appId),
    mchid: args.rt.mchId,
    description: String(args.description || "").trim() || "写作 IDE 充值",
    out_trade_no: normStr(args.outTradeNo),
    notify_url: args.rt.notifyUrl,
    amount: { total: Math.max(1, Math.floor(Number(args.amountCent) || 0)), currency: "CNY" },
    payer: { openid: normStr(args.openid) },
  };
  const resp = await wxpayRequestJson({ method: "POST", url, body, rt: args.rt });
  const prepayId = typeof resp?.prepay_id === "string" ? String(resp.prepay_id) : "";
  if (!prepayId) {
    const err: any = new Error("WXPAY_PREPAY_FAILED");
    err.detail = { resp };
    throw err;
  }
  return { prepayId };
}

export function generateJsapiPayParams(args: {
  rt: WxPayRuntime;
  appId: string;
  prepayId: string;
}): { appId: string; timeStamp: string; nonceStr: string; package: string; signType: "RSA"; paySign: string } {
  const timeStamp = Math.floor(Date.now() / 1000).toString();
  const nonceStr = generateNonce();
  const pkg = `prepay_id=${normStr(args.prepayId)}`;
  const message = `${normStr(args.appId)}\n${timeStamp}\n${nonceStr}\n${pkg}\n`;
  const paySign = signRsaSha256Base64(message, args.rt.privateKey);
  return { appId: normStr(args.appId), timeStamp, nonceStr, package: pkg, signType: "RSA", paySign };
}

export function verifyWxPayNotifySignature(args: {
  rt: WxPayRuntime;
  headers: Record<string, any>;
  rawBody: string;
}): { ok: true } | { ok: false; error: string } {
  const ts = normStr(args.headers["wechatpay-timestamp"]);
  const nonce = normStr(args.headers["wechatpay-nonce"]);
  const sig = normStr(args.headers["wechatpay-signature"]);
  const serial = normStr(args.headers["wechatpay-serial"]);
  if (!ts || !nonce || !sig || !serial) return { ok: false, error: "notify_headers_missing" };

  // serial 可选严格校验（避免被其它 serial 的公钥冒充）
  if (args.rt.verifyStrict && args.rt.platformPublicKeyId && serial !== args.rt.platformPublicKeyId) {
    return { ok: false, error: "notify_serial_mismatch" };
  }
  if (!args.rt.platformPublicKey) return { ok: false, error: "platform_public_key_missing" };

  const message = `${ts}\n${nonce}\n${args.rawBody}\n`;
  const ok = verifyRsaSha256Base64({ message, signatureBase64: sig, publicKey: args.rt.platformPublicKey });
  return ok ? { ok: true } : { ok: false, error: "notify_signature_invalid" };
}

export function decryptWxPayResourceToJson(args: {
  rt: WxPayRuntime;
  resource: { ciphertext: string; associated_data?: string; nonce: string };
}): any {
  const key = normStr(args.rt.apiV3Key);
  if (!key || key.length < 32) throw new Error("api_v3_key_missing");
  const nonce = Buffer.from(normStr(args.resource.nonce), "utf8");
  const aad = Buffer.from(normStr(args.resource.associated_data ?? ""), "utf8");
  const data = Buffer.from(normStr(args.resource.ciphertext), "base64");
  if (data.length <= 16) throw new Error("ciphertext_too_short");
  const ct = data.subarray(0, data.length - 16);
  const tag = data.subarray(data.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(key, "utf8"), nonce);
  decipher.setAuthTag(tag);
  if (aad.length) decipher.setAAD(aad);
  const out = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  try {
    return JSON.parse(out);
  } catch {
    return { raw: out };
  }
}

