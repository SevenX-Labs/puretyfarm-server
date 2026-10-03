export interface JwtPayload {
  sub: string;
  role: string;
  sessionId: string;
  type: 'access' | 'refresh';
}
