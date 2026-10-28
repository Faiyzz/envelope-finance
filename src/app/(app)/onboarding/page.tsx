import { OnboardingForm } from '@/components/forms/onboarding-form';
import { msg } from '@/messages/en';

export default function OnboardingPage() {
  return (
    <div className="mx-auto grid max-w-md gap-4">
      <h1 className="text-2xl font-bold">{msg.page.welcome()}</h1>
      <p className="text-muted-foreground">{msg.page.welcomeBody()}</p>
      <OnboardingForm />
    </div>
  );
}
