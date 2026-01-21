import DypnsapiModule, { CheckSmsVerifyCodeRequest, SendSmsVerifyCodeRequest } from "@alicloud/dypnsapi20170525";
import { $OpenApiUtil } from "@alicloud/openapi-core";
import type { SmsVerifyRuntime } from "./toolConfig.js";

function stripProtocol(endpoint: string): string {
  const s = String(endpoint ?? "").trim();
  return s.replace(/^https?:\/\//i, "").replace(/\/+$/g, "");
}

export function normalizeCnPhone(raw: string): string {
  const s = String(raw ?? "").trim().replace(/[^\d+]/g, "");
  // 仅支持国内：允许 +86 / 86 前缀
  let x = s;
  if (x.startsWith("+86")) x = x.slice(3);
  if (x.startsWith("86") && x.length > 11) x = x.slice(2);
  x = x.replace(/[^\d]/g, "");
  return x;
}

export function createDypnsClient(rt: SmsVerifyRuntime) {
  // @alicloud/* 这类 SDK 通常是 CommonJS 导出：module.exports = { ..., default: Client }
  // 在 Node ESM 下 `import x from` 拿到的是整个 module.exports（对象），构造器在 x.default 上；
  // 如果直接 new x(...) 会报：Client is not a constructor
  const ClientCtor = ((DypnsapiModule as any)?.default ?? DypnsapiModule) as any;
  const cfg = new $OpenApiUtil.Config({
    accessKeyId: rt.accessKeyId,
    accessKeySecret: rt.accessKeySecret,
    endpoint: stripProtocol(rt.endpoint),
  });
  // Dypnsapi 是 RPC 风格；regionId 不强制，但留默认值更稳
  cfg.regionId = cfg.regionId || "cn-hangzhou";
  return new ClientCtor(cfg);
}

export async function sendSmsVerifyCode(args: {
  rt: SmsVerifyRuntime;
  phoneNumber: string;
  countryCode?: string;
  outId?: string;
  returnVerifyCode?: boolean;
}) {
  const client = createDypnsClient(args.rt);
  const req = new SendSmsVerifyCodeRequest({
    schemeName: args.rt.schemeName ?? undefined,
    countryCode: String(args.countryCode ?? "86"),
    phoneNumber: args.phoneNumber,
    signName: args.rt.signName,
    templateCode: args.rt.templateCode,
    templateParam: JSON.stringify({ code: "##code##", min: String(args.rt.templateMin) }),
    outId: args.outId,
    codeLength: args.rt.codeLength,
    validTime: args.rt.validTimeSeconds,
    duplicatePolicy: args.rt.duplicatePolicy,
    interval: args.rt.intervalSeconds,
    codeType: args.rt.codeType,
    autoRetry: args.rt.autoRetry,
    returnVerifyCode: Boolean(args.returnVerifyCode),
  });
  const resp = await client.sendSmsVerifyCode(req);
  return resp.body;
}

export async function checkSmsVerifyCode(args: {
  rt: SmsVerifyRuntime;
  phoneNumber: string;
  verifyCode: string;
  countryCode?: string;
  outId?: string;
  caseAuthPolicy?: number;
}) {
  const client = createDypnsClient(args.rt);
  const req = new CheckSmsVerifyCodeRequest({
    schemeName: args.rt.schemeName ?? undefined,
    countryCode: String(args.countryCode ?? "86"),
    phoneNumber: args.phoneNumber,
    outId: args.outId,
    verifyCode: args.verifyCode,
    caseAuthPolicy: args.caseAuthPolicy ?? 1,
  });
  const resp = await client.checkSmsVerifyCode(req);
  return resp.body;
}


