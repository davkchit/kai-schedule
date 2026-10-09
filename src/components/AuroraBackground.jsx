// The drifting blue light behind the entry pages (search, teacher lookup,
// admin login) and the error screen. Styles: .aurora in src/styles/base.css.
export default function AuroraBackground() {
    return (
        <div className="aurora" aria-hidden="true">
            <div className="aurora-blob aurora-blob-1"></div>
            <div className="aurora-blob aurora-blob-2"></div>
            <div className="aurora-blob aurora-blob-3"></div>
            <div className="aurora-blob aurora-blob-4"></div>
        </div>
    );
}
