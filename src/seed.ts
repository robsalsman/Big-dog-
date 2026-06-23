import { randomUUID } from 'node:crypto';
import { messages, deals, events, isEmpty } from './db.js';
import { threadKey } from './threading.js';

/**
 * Seed a realistic slice of inbox + pipeline + calendar so Big Dog is alive
 * the moment you start it — before you've wired up any real mailboxes.
 * No-ops once you have real data.
 */
export function seedDemoData(): void {
  if (!isEmpty()) return;

  const now = Date.now();
  const hrs = (h: number) => new Date(now + h * 3600_000).toISOString();
  const daysAgo = (d: number) => new Date(now - d * 86_400_000).toISOString();

  const demoMessages = [
    {
      fromName: 'Dana Whitfield',
      fromEmail: 'dana@northwind.io',
      subject: 'Re: Pricing for the 40-seat rollout',
      body:
        "Hey — talked it over with the team and we're ready to move on the 40 seats. " +
        'Can you send over a formal proposal this week? Also curious if annual prepay gets us a better number. ' +
        "We'd want to be live by end of quarter.",
      priority: 'hot',
      summary: 'Northwind ready to buy 40 seats — wants a proposal + annual pricing.',
    },
    {
      fromName: 'Marcus Lee',
      fromEmail: 'marcus@brightpath.co',
      subject: 'Quick demo next week?',
      body:
        'Saw your post on inbound workflows. We have a similar mess. Any chance you could walk a few of us through it? ' +
        'Tuesday or Wednesday afternoon would be ideal.',
      priority: 'warm',
      summary: 'Brightpath wants a demo Tue/Wed afternoon.',
    },
    {
      fromName: 'Priya Nair',
      fromEmail: 'priya@vertexlabs.ai',
      subject: 'Following up on our call',
      body:
        'Thanks for the time yesterday. The deck looked great. I need to loop in our VP of Ops before we commit — ' +
        "she's back Thursday. Will circle back after that.",
      priority: 'warm',
      summary: 'Vertex Labs needs internal sign-off (VP back Thursday).',
    },
    {
      fromName: 'AWS Billing',
      fromEmail: 'no-reply@aws.amazon.com',
      subject: 'Your invoice is available',
      body: 'Your AWS invoice for last month is now available in the billing console.',
      priority: 'cold',
      summary: 'AWS invoice notification.',
    },
  ];

  for (const m of demoMessages) {
    messages.upsert({
      id: randomUUID().slice(0, 16),
      accountId: 'demo',
      messageId: `<${randomUUID()}@demo>`,
      threadId: threadKey(m.subject, m.fromEmail),
      fromName: m.fromName,
      fromEmail: m.fromEmail,
      toEmails: 'you@yourcompany.com',
      subject: m.subject,
      snippet: m.body.slice(0, 200),
      body: m.body,
      date: daysAgo(Math.random()),
      folder: 'INBOX',
      unread: 1,
      dealId: null,
      priority: m.priority as 'hot' | 'warm' | 'cold',
      summary: m.summary,
      analyzed: 1,
    });
  }

  const demoDeals = [
    {
      title: 'Northwind — 40-seat rollout',
      contactName: 'Dana Whitfield',
      contactEmail: 'dana@northwind.io',
      company: 'Northwind',
      stage: 'proposal' as const,
      value: 48000,
      nextStep: 'Send formal proposal with annual prepay option',
      nextStepDue: new Date(now + 2 * 86_400_000).toISOString().slice(0, 10),
    },
    {
      title: 'Vertex Labs — platform deal',
      contactName: 'Priya Nair',
      contactEmail: 'priya@vertexlabs.ai',
      company: 'Vertex Labs',
      stage: 'qualified' as const,
      value: 30000,
      nextStep: 'Follow up after VP of Ops returns Thursday',
      nextStepDue: new Date(now + 4 * 86_400_000).toISOString().slice(0, 10),
    },
    {
      title: 'Brightpath — inbound workflows',
      contactName: 'Marcus Lee',
      contactEmail: 'marcus@brightpath.co',
      company: 'Brightpath',
      stage: 'new' as const,
      value: null,
      nextStep: 'Book the demo for Tue/Wed afternoon',
      nextStepDue: new Date(now + 1 * 86_400_000).toISOString().slice(0, 10),
    },
  ];

  for (const d of demoDeals) {
    deals.upsert({
      id: randomUUID().slice(0, 16),
      title: d.title,
      contactName: d.contactName,
      contactEmail: d.contactEmail,
      company: d.company,
      stage: d.stage,
      value: d.value,
      notes: '',
      nextStep: d.nextStep,
      nextStepDue: d.nextStepDue,
      createdAt: daysAgo(5),
      updatedAt: daysAgo(1),
      lastActivity: daysAgo(1),
    });
  }

  events.upsert({
    id: randomUUID().slice(0, 16),
    title: 'Demo — Brightpath (Marcus Lee)',
    start: hrs(26),
    end: hrs(26.5),
    location: 'Video call',
    attendees: 'marcus@brightpath.co',
    notes: 'Walk through inbound workflows. Goal: book a follow-up.',
    dealId: null,
    source: 'big-dog',
  });
  events.upsert({
    id: randomUUID().slice(0, 16),
    title: 'Proposal review — Northwind',
    start: hrs(48),
    end: hrs(48.5),
    location: 'Internal',
    attendees: '',
    notes: 'Finalize annual prepay numbers before sending to Dana.',
    dealId: null,
    source: 'big-dog',
  });
}
