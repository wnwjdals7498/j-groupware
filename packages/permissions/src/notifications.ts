export const NOTIFICATION_TYPES = {
  "approval.turn": {
    service: "j-approval",
    role: "approval:use",
    icon: "approval",
    label: "결재 차례",
    link: /^\/approval\/documents\/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/,
  },
  "approval.done": {
    service: "j-approval",
    role: "approval:use",
    icon: "approval",
    label: "결재 결과",
    link: /^\/approval\/documents\/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/,
  },
  "talk.new": {
    service: "j-talk",
    role: "talk:read",
    icon: "talk",
    label: "새 문의",
    link: /^\/talk\/rooms\/[A-Za-z0-9_-]{1,128}$/,
  },
  "talk.assigned": {
    service: "j-talk",
    role: "talk:read",
    icon: "talk",
    label: "문의 배정",
    link: /^\/talk\/rooms\/[A-Za-z0-9_-]{1,128}$/,
  },
  "mail.new": {
    service: "j-mail",
    role: "mail:read",
    icon: "mail",
    label: "새 메일",
    link: /^\/mail\/messages\/[A-Za-z0-9_-]{1,128}$/,
  },
} as const;
export type NotificationType = keyof typeof NOTIFICATION_TYPES;
export type NotificationService =
  (typeof NOTIFICATION_TYPES)[NotificationType]["service"];
export interface NotificationInput {
  readonly tenant: string;
  readonly service: NotificationService;
  readonly type: NotificationType;
  readonly members?: readonly string[];
  readonly usernames?: readonly string[];
  readonly role?: string;
  readonly title: string;
  readonly body: string;
  readonly link: string;
  readonly dedupKey: string;
}
export interface NotificationItem {
  readonly id: string;
  readonly service: NotificationService;
  readonly type: NotificationType;
  readonly icon: string;
  readonly label: string;
  readonly title: string;
  readonly body: string;
  readonly link: string;
  readonly createdAt: string;
  readonly readAt: string | null;
}
export interface NotificationPage {
  readonly items: readonly NotificationItem[];
  readonly nextCursor: string | null;
  readonly unread: number;
}
export type NotificationKeyHashes = Partial<
  Record<NotificationService, readonly string[]>
>;
