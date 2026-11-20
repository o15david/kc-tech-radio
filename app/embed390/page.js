// Temporary layout-check page (added Nov 20, 2026): embeds the
// station in a 390px-wide iframe so the phone masthead composition
// can be verified in a desktop browser, whose window cannot be
// narrowed to phone width. Remove once the masthead is confirmed.
export const metadata = { title: '390px embed check' };

export default function Embed390() {
  return (
    <div
      style={{
        margin: 0,
        background: '#333',
        minHeight: '100vh',
        display: 'flex',
        justifyContent: 'center',
        padding: '12px',
      }}
    >
      <iframe
        src="/"
        title="KC Tech Radio at 390px"
        style={{ width: 390, height: 844, border: '2px solid #c8871a', background: '#000' }}
      />
    </div>
  );
}
