import { redirect } from 'next/navigation';

/** The section has no page of its own: it opens on the people. */
export default function Page() {
  redirect('/settings/access/people');
}
