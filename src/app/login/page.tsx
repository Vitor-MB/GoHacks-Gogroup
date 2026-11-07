import Image from "next/image";
import logo from "../../../assets/brand/gobia-logo-v1.png";
import { LoginForm } from "./login-form";

export default function LoginPage() {
  return (
    <main className="welcome">
      <section className="welcome-card" aria-labelledby="login-title">
        <Image className="brand" src={logo} alt="GoBIA" sizes="180px" />
        <p className="eyebrow">Acesso da equipe</p>
        <h1 id="login-title">Entrar</h1>
        <LoginForm />
      </section>
    </main>
  );
}
