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
}

export interface Draft {
  id: string;
  accountId: string;
  inReplyTo: string | null; // message id
  dealId: string | null;
  toEmails: string;
  ccEmails?: string | null; // comma-separated CC recipients
  subject: string;
  body: string;
  rationale: string;
  status: 'pending' | 'sent' | 'discarded';
  createdAt: string;
  sentAt: string | null;
  sendAt?: string | null; // schedule a send for later
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
}

/** What Claude returns when triaging a single inbound message. */
export interface MessageAnalysis {
  priority: 'hot' | 'warm' | 'cold';
  summary: string;
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
