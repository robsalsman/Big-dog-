// Shared types for Big Dog.

export interface MailboxConn {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

export interface Account {
  id: string;
  label: string;
  email: string;
  imap: MailboxConn;
  smtp: MailboxConn;
}

export interface Owner {
  name: string;
  title: string;
  company: string;
  signature: string;
  voiceNotes: string;
}

export interface AccountsConfig {
  owner: Owner;
  accounts: Account[];
}

export type DealStage = 'new' | 'qualified' | 'proposal' | 'won' | 'lost';

export const DEAL_STAGES: DealStage[] = ['new', 'qualified', 'proposal', 'won', 'lost'];

export interface Message {
  id: string;
  accountId: string;
  messageId: string; // RFC 2822 Message-ID
  threadId: string;
  fromName: string;
  fromEmail: string;
  toEmails: string;
  subject: string;
  snippet: string;
  body: string;
  date: string; // ISO
  folder: string;
  unread: 0 | 1;
  dealId: string | null;
  priority: 'hot' | 'warm' | 'cold' | null;
  summary: string | null;
  category?: string | null;
  meetingReq?: 0 | 1; // triage flagged this as a meeting request / interested reply
  analyzed: 0 | 1;
}

export interface Deal {
  id: string;
  title: string;
  contactName: string;
  contactEmail: string;
  company: string;
  stage: DealStage;
  value: number | null;
  notes: string;
  nextStep: string;
  nextStepDue: string | null; // ISO date
  createdAt: string;
  updatedAt: string;
  lastActivity: string;
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: string; // ISO
  end: string; // ISO
  location: string;
  attendees: string;
  notes: string;
  dealId: string | null;
  source: string; // 'manual' | 'message' | 'big-dog'
  zoomMeetingId?: string | null;
}

export interface Draft {
  id: string;
  accountId: string;
  inReplyTo: string | null; // message id
  dealId: string | null;
  toEmails: string;
  ccEmails?: string | null; // comma-separated CC recipients
  attachmentIds?: string | null; // JSON array of repository attachment ids
  subject: string;
  body: string;
  rationale: string;
  status: 'pending' | 'sent' | 'discarded';
  createdAt: string;
  sentAt: string | null;
  sendAt?: string | null; // schedule a send for later
}

// ── Drip sequences (inspired by Dittofeed journeys / Parcelvoy campaigns) ──
export interface SequenceStep {
  dayOffset: number; // days after enrollment to send this step
  subject: string;
  instruction: string; // what this touch should say (AI-personalized in your voice)
}
export interface Sequence {
  id: string;
  name: string;
  steps: SequenceStep[];
  active: boolean;
  autoSend?: boolean; // send touches autonomously (vs queue as drafts)
  createdAt: string;
}
export interface Enrollment {
  id: string;
  sequenceId: string;
  email: string;
  name: string;
  company: string;
  accountId: string;
  dealId: string | null;
  step: number; // next step index to send
  status: 'active' | 'completed' | 'stopped' | 'replied';
  startedAt: string;
  nextRunAt: string;
  lastError: string | null;
}

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  path: string;
  notes: string;
  createdAt: string;
}

export interface Contact {
  email: string;
  name: string;
  company: string;
  title: string;
  phone: string;
  notes: string;
  tags: string;
  firstSeen: string;
  lastSeen: string;
  updatedAt: string;
}

export interface Digest {
  id: string;
  date: string; // YYYY-MM-DD
  content: string;
  createdAt: string;
}

/** A sourced sales prospect (ZoomInfo-style lead gen). */
export interface Prospect {
  name: string;
  title: string;
  company: string;
  domain: string; // company email domain, for email finding
  email: string;
  linkedin: string;
  location: string;
  source: string; // 'web' | 'apollo'
  notes: string;
  verifyStatus?: 'verified' | 'deliverable' | 'catch-all' | 'unverified';
}

export type MessageCategory = 'reply' | 'fyi' | 'promotion' | 'invoice' | 'receipt' | 'notification' | 'spam';

/** What Claude returns when triaging a single inbound message. */
export interface MessageAnalysis {
  priority: 'hot' | 'warm' | 'cold';
  summary: string;
  category: MessageCategory; // what KIND of email this is
  needsReply: boolean; // a real person expecting a response (vs receipts/promos/notifications)
  isSalesOpportunity: boolean;
  deal?: {
    title: string;
    company: string;
    contactName: string;
    suggestedStage: DealStage;
    estimatedValue: number | null;
    nextStep: string;
  };
  isMeetingRequest: boolean;
  meeting?: {
    title: string;
    proposedStart: string | null; // ISO or null if needs proposing
    durationMinutes: number;
    location: string;
  };
}
