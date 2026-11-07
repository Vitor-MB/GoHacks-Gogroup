import Image from "next/image";
import logo from "../../assets/brand/gobia-logo-v1.png";
import { signOut } from "../server/auth/actions";
import { getCurrentStaff } from "../server/auth/session";

function describeScope(scope: { scope: string; business_unit_id: string | null; brand_id: string | null }) {
  if (scope.scope === "group") return "Grupo (todas as unidades)";
  if (scope.scope === "unit") return `Unidade: ${scope.business_unit_id}`;
  return `Marca: ${scope.brand_id}`;
}

export default async function Home() {
  const staff = await getCurrentStaff();

  return (
    <main className="welcome">
      <section className="welcome-card" aria-labelledby="welcome-title">
        <Image className="brand" src={logo} alt="GoBIA" sizes="180px" />
        <p className="eyebrow">GoHacks Talent · GoGroup</p>
        <h1 id="welcome-title">Central de atendimento</h1>
        {staff ? (
          <>
            <p className="intro">
              Olá, {staff.fullName}. Papel: <strong>{staff.role}</strong>.
            </p>
            <ul className="scopes">
              {staff.scopes.length ? (
                staff.scopes.map((s, i) => <li key={i}>{describeScope(s)}</li>)
              ) : (
                <li>Nenhum escopo atribuído</li>
              )}
            </ul>
          </>
        ) : (
          <p className="intro">
            Sua conta está autenticada, mas não está vinculada a um funcionário ativo. Peça a liberação à
            supervisão.
          </p>
        )}
        <p className="status">MVP em desenvolvimento</p>
        <form action={signOut} className="signout">
          <button type="submit">Sair</button>
        </form>
      </section>
    </main>
  );
}
