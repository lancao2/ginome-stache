export type WhatsappState =
  | "off" | "unavailable" | "connecting" | "qr" | "open" | "reconnecting" | "logged_out" | "stopped";

export interface WhatsappMedia {
  kind: "image" | "sticker" | "audio";
  src: string;
  seconds?: number;
}

export interface WhatsappMessage {
  id: string;
  from: "them" | "me";
  sender: string;
  text: string;
  kind: "text" | "audio" | "media";
  media?: WhatsappMedia | null;
  at: number;
  /** Só nas mensagens enviadas por mim. */
  status?: "sending" | "sent" | "delivered" | "read" | "failed";
  /** Id da mensagem no WhatsApp, usado para casar confirmações. */
  remoteId?: string;
}

export interface WhatsappChat {
  jid: string;
  name: string;
  isGroup: boolean;
  avatar: string | null;
  canSend: boolean;
  unread: number;
  updatedAt: number;
  messages: WhatsappMessage[];
}

export interface WhatsappIncoming {
  id: string;
  jid: string;
  isGroup: boolean;
  name: string;
  sender: string;
  avatar?: string | null;
  canSend?: boolean;
  text: string;
  media?: WhatsappMedia | null;
  kind: "text" | "audio" | "media";
  at: number;
}
