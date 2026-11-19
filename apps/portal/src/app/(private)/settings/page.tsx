import type { Metadata } from "next";
import { requireSession } from "@/lib/session";
import { DeleteAccountForm } from "./delete-account-form";
import { cardClass } from "@/components/ui/card";

export const metadata: Metadata = { title: "Account" };

// Configurações da conta (#154). Hoje só o nome e o e-mail (a retificação de
// e-mail por tela fica para a issue de pedidos de titulares) e a exclusão da
// própria conta.
export default async function AccountPage() {
  const { user } = await requireSession();

  return (
    <section>
      <h1 className="text-2xl font-semibold tracking-tight">Account</h1>
      <dl className={`${cardClass} mt-4 max-w-3xl divide-y divide-border py-1 text-sm`}>
        <div className="flex justify-between py-2">
          <dt className="text-muted">Email</dt>
          <dd>{user.email}</dd>
        </div>
        <div className="flex justify-between py-2">
          <dt className="text-muted">Name</dt>
          <dd>{user.name}</dd>
        </div>
        <div className="flex justify-between py-2">
          <dt className="text-muted">Role</dt>
          <dd className="capitalize">{user.role}</dd>
        </div>
      </dl>

      <div className="mt-8 max-w-3xl rounded-card border border-bad/40 bg-surface p-4">
        <h2 className="text-lg font-semibold text-bad">Delete account</h2>
        <DeleteAccountForm email={user.email} />
      </div>
    </section>
  );
}
