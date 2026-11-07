import Image from "next/image";
import { redirect } from "next/navigation";
import logo from "../../assets/brand/gobia-logo-v1.png";
import { signOut } from "../server/auth/actions";
import { getCurrentStaff } from "../server/auth/session";

export default async function Home() {
  const staff = await getCurrentStaff();
  if (staff) redirect("/painel");

  return (
    <main className="welcome">
      <section className="welcome-card" aria-labelledby="welcome-title">
        <Image className="brand" src={logo} alt="GoBIA" sizes="180px" />
        <p className="eyebrow">GoHacks Talent · GoGroup</p>
        <h1 id="welcome-title">Central de atendimento</h1>
        <p className="intro">
          Sua conta está autenticada, mas não está vinculada a um funcionário ativo. Peça a liberação à supervisão.
        </p>
        <form action={signOut} className="signout">
          <button type="submit">Sair</button>
        </form>
      </section>
    </main>
  );
}
