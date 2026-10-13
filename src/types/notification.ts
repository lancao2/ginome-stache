export interface SystemNotification {
  id: number;
  app: string;
  summary: string;
  body: string;
  createdAt: string;
  icon: string | null;
}
