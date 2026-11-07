import Image from "next/image";
import logo from "../../assets/brand/gobia-logo-v1.png";

export default function Home() {
  return (
    <main className="welcome">
      <section className="welcome-card" aria-labelledby="welcome-title">
        <Image className="brand" src={logo} alt="GoBIA" sizes="180px" />
        <p className="eyebrow">GoHacks Talent · GoGroup</p>
        <h1 id="welcome-title">Central de atendimento</h1>
        <p className="intro">
          A GoBIA foi pensada para investigar atrasos de entrega, acompanhar o
          cliente e encaminhar casos à equipe responsável quando necessário.
        </p>
        <p className="status">MVP em desenvolvimento</p>
      </section>
    </main>
  );
}
