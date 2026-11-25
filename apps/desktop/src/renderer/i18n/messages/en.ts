import { app } from './en/app';
import { api } from './en/api';
import { bots } from './en/bots';
import { chat } from './en/chat';
import { composer } from './en/composer';
import { tools } from './en/tools';
import { attachments } from './en/attachments';
import { transcript } from './en/transcript';
import { sidebar } from './en/sidebar';
import { call } from './en/call';
import { connection } from './en/connection';
import { experience } from './en/experience';
import { launch } from './en/launch';
import { routines } from './en/routines';
import { screen } from './en/screen';
import { settings } from './en/settings';
import { skills } from './en/skills';
import { visuals } from './en/visuals';
import { voice } from './en/voice';
import { work } from './en/work';

/**
 * The English catalog, and the source every other language is
 * translated from.
 *
 * Keys are flat and named by where the words appear. A value's `{name}`
 * placeholders are the parameters `t` demands for that key, so a call that
 * forgets one does not compile. A plural message carries `other` and the
 * categories English uses; a translation carries the categories ITS language
 * uses, which the catalog check reads from `Intl.PluralRules`.
 *
 * Split by area so each area's words sit together; the merge below is the
 * catalog, and a key defined twice is a test failure rather than a silent
 * overwrite.
 */
export const EN_PARTS = {
  app,
  api,
  bots,
  chat,
  composer,
  tools,
  attachments,
  transcript,
  sidebar,
  call,
  connection,
  experience,
  launch,
  routines,
  screen,
  settings,
  skills,
  visuals,
  voice,
  work,
} as const;

export const en = {
  ...app,
  ...api,
  ...bots,
  ...chat,
  ...composer,
  ...tools,
  ...attachments,
  ...transcript,
  ...sidebar,
  ...call,
  ...connection,
  ...experience,
  ...launch,
  ...routines,
  ...screen,
  ...settings,
  ...skills,
  ...visuals,
  ...voice,
  ...work,
} as const;
