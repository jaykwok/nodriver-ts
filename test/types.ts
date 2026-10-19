import type { Session } from '../src/index.ts';
function compileTimeContract(session: Session) {
  void session.send('Browser.getVersion');
  void session.send('Page.navigate', { url: 'about:blank' });
  // @ts-expect-error Page.navigate requires params
  void session.send('Page.navigate');
  // @ts-expect-error no-argument commands do not accept arbitrary params
  void session.send('Browser.getVersion', {});
  // @ts-expect-error URL is a string
  void session.send('Page.navigate', { url: 42 });
  session.on('Page.frameNavigated', (event) => {
    const id: string = event.frame.id;
    void id;
  });
}
void compileTimeContract;
