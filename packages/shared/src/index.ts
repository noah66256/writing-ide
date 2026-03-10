export type User = {
  id: string;
  email: string;
  role?: "admin" | "user";
  pointsBalance?: number;
  createdAt?: string;
};

export type EmailCodeRequestResponse = {
  requestId: string;
  expiresInSeconds: number;
  devCode?: string;
};

export type EmailVerifyResponse = {
  accessToken: string;
  user: User;
};

export * from "./contextSegments";

