import React from 'react';

interface PlannedItem {
  icon: string;
  label: string;
  description: string;
}

interface FeatureUnavailableProps {
  /** Page heading, in the same style as the other dashboards. */
  title: string;
  subtitle: string;
  /** Font Awesome icon (without the "fas" prefix) for the header tile. */
  icon: string;
  /** Short statement of what is not available and why. */
  headline: string;
  message: string;
  items: PlannedItem[];
  footnote?: string;
}

/**
 * An honest, non-interactive page for a console whose backend is not
 * connected yet. It deliberately shows no data and no controls: nothing
 * here reads or writes the browser's local storage as if it were the
 * platform's records.
 */
const FeatureUnavailable: React.FC<FeatureUnavailableProps> = ({
  title,
  subtitle,
  icon,
  headline,
  message,
  items,
  footnote
}) => (
  <div className="max-w-7xl mx-auto px-4 py-8 font-sans">
    <div className="flex items-center gap-3 mb-8">
      <div
        className="w-12 h-12 bg-neutral-900 transform -skew-x-12 flex items-center justify-center text-white"
        aria-hidden="true"
      >
        <i className={`fas ${icon}`}></i>
      </div>
      <div>
        <h2 className="text-3xl sm:text-4xl font-black text-neutral-900 uppercase italic tracking-tighter">
          {title}
        </h2>
        <p className="text-neutral-500 text-xs font-bold uppercase tracking-widest">
          {subtitle}
        </p>
      </div>
    </div>

    <section
      role="status"
      aria-labelledby="feature-unavailable-heading"
      className="bg-white rounded-lg border-2 border-neutral-100 p-6 sm:p-8"
    >
      <div className="flex items-start gap-4">
        <div
          className="w-10 h-10 shrink-0 bg-orange-50 text-orange-600 rounded-sm flex items-center justify-center text-lg"
          aria-hidden="true"
        >
          <i className="fas fa-plug-circle-xmark"></i>
        </div>
        <div>
          <h3
            id="feature-unavailable-heading"
            className="font-black text-neutral-900 uppercase tracking-tight text-lg"
          >
            {headline}
          </h3>
          <p className="text-sm text-neutral-600 mt-2 max-w-2xl">{message}</p>
        </div>
      </div>

      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-8">
        {items.map(item => (
          <li
            key={item.label}
            className="flex items-start gap-3 p-4 bg-neutral-50 rounded-lg border-2 border-neutral-100"
          >
            <i
              className={`fas ${item.icon} text-neutral-400 mt-1`}
              aria-hidden="true"
            ></i>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-xs font-black text-neutral-900 uppercase tracking-tight">
                  {item.label}
                </p>
                <span className="px-2 py-0.5 bg-neutral-200 text-neutral-600 rounded-sm text-[9px] font-black uppercase tracking-wider">
                  Not available yet
                </span>
              </div>
              <p className="text-xs text-neutral-500 mt-1">{item.description}</p>
            </div>
          </li>
        ))}
      </ul>

      {footnote && (
        <p className="text-[11px] text-neutral-400 font-bold uppercase tracking-widest mt-8">
          {footnote}
        </p>
      )}
    </section>
  </div>
);

export default FeatureUnavailable;
