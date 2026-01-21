# 阿里云短信验证码（号码认证服务 Dypnsapi）接入方案 v1

> 目标：在写作 IDE 中实现 **手机号验证码登录**（保留邮箱入口），并让 Gateway 能做 **验证码发送/校验** 与 **审计/频控**，B 端可热配置签名/模板/密钥。

## 1. API 选型与关键结论

- **发送**：`SendSmsVerifyCode`（短信认证服务）
  - 必填：`PhoneNumber` / `SignName` / `TemplateCode` / `TemplateParam`
  - 可控：验证码长度、有效期、频控间隔、重复策略、验证码类型等
  - 说明：`TemplateParam` 支持 `{"code":"##code##","min":"5"}` 让阿里云生成验证码，并支持后续校验；若传固定值（如 `{"code":"123456"}`）则 **阿里云无法校验**。

- **校验**：`CheckSmsVerifyCode`（短信认证服务）
  - 必填：`PhoneNumber` / `VerifyCode`
  - 可选：`CountryCode`（默认 86）/ `SchemeName` / `OutId` / `CaseAuthPolicy`
  - **重要**：接口返回 `Code=OK` 仅代表“请求成功”，**验证码是否通过必须看 `Model.VerifyResult`**，其中 `PASS` 才表示校验成功。

参考文档：
- 发送接口：`SendSmsVerifyCode - 发送短信验证码`（阿里云帮助中心）
- 校验接口：`CheckSmsVerifyCode - 核验验证码`（阿里云帮助中心）

## 2. 我们的落地策略（本项目）

### 2.1 Gateway 接口（v1）

- `POST /api/auth/phone/request-code`
  - 入参：`phoneNumber`（国内手机号，默认 `countryCode=86`）
  - 行为：调用 `SendSmsVerifyCode`，并返回 `requestId`（本地请求ID）+ `expiresInSeconds`
  - 备注：开发环境可返回 `devCode`（如果阿里云返回了 VerifyCode）

- `POST /api/auth/phone/verify`
  - 入参：`phoneNumber` + `requestId` + `code`
  - 行为：调用 `CheckSmsVerifyCode`；当 `success=true && Model.verifyResult==="PASS"` 时登录成功

### 2.2 配置与密钥（v1：B 端热配置 + env 兜底）

在 Gateway `toolConfig.smsVerify` 中保存：
- `AccessKeyId/AccessKeySecret`（AES-GCM 加密存储，B 端只展示 `****last4`）
- `endpoint`（可选覆盖，默认 `dypnsapi.aliyuncs.com`）
- `signName / templateCode / schemeName`
- `validTimeSeconds / intervalSeconds / duplicatePolicy / codeLength / codeType / autoRetry`

env 兜底（可选）：
- `ALIYUN_ACCESS_KEY_ID` / `ALIYUN_ACCESS_KEY_SECRET`（也兼容 `ALIBABA_CLOUD_ACCESS_KEY_ID/SECRET`）
- `ALIYUN_DYPNSAPI_ENDPOINT`
- `ALIYUN_DYPNSAPI_SIGN_NAME` / `ALIYUN_DYPNSAPI_TEMPLATE_CODE` / `ALIYUN_DYPNSAPI_SCHEME_NAME`

## 3. 验收清单（v1）

- 能在 Desktop 端输入手机号 → 发送验证码 → 输入验证码登录成功
- `/api/me` 能返回 `user.phone/email/pointsBalance`
- B 端 Tools 页可配置 SMS Verify，并通过“测试配置”（不发短信）
- 计费链路：有登录态时，模型调用可记录扣费流水（pointsTransactions）

## 4. 回滚方案

- 关闭 `SMS Verify`：B 端把 `isEnabled=false` 或清空密钥即可回退到“仅邮箱验证码”
- Desktop 端：不影响离线写作；仅禁用登录/计费相关能力


