import { useState } from "react";
import { ChevronDownIcon } from "./Icons.jsx";

export default function FaqSection({ faq }) {
  const [openIndex, setOpenIndex] = useState(0);

  if (!faq) return null;

  return (
    <section className="section" id="faq">
      <div className="section-head">
        <span className="eyebrow">FAQ</span>
        <h2>Questions worth asking</h2>
      </div>
      <div className="faq-accordion">
        {faq.map((item, i) => {
          const open = openIndex === i;
          return (
            <div className={`faq-row ${open ? "open" : ""}`} key={item.q}>
              <button
                type="button"
                className="faq-row-head"
                onClick={() => setOpenIndex(open ? -1 : i)}
                aria-expanded={open}
              >
                <span>{item.q}</span>
                <ChevronDownIcon className="faq-chevron" />
              </button>
              <div className="faq-row-body">
                <p>{item.a}</p>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
