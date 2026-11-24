import { Card, PageHead } from '../ui/kit';

export function Comms() {
  return (
    <>
      <PageHead title="Messages" sub="Notifications to riders" />
      <div className="page">
        <Card title="Not set up yet">
          <p>Sending messages to riders (class reminders, waitlist offers, cancellations) needs a message provider for email, SMS and push. The club has not chosen one yet, so nothing is sent from here.</p>
          <p className="sub">Once a provider is chosen, the templates, history and delivery status will appear on this page.</p>
        </Card>
      </div>
    </>
  );
}
