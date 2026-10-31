import { render, screen } from '@testing-library/react';
import App from './App';

// The uploader reads the recent-uploads list on mount; stub fetch so the test
// does not depend on a running backend.
beforeEach(() => {
  global.fetch = jest.fn(() =>
    Promise.resolve({ ok: true, text: () => Promise.resolve('[]') }),
  );
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('renders the uploader heading', async () => {
  render(<App />);
  expect(await screen.findByText(/Large File Uploader/i)).toBeInTheDocument();
});

test('shows the upload button disabled until a file is chosen', async () => {
  render(<App />);
  const button = await screen.findByRole('button', { name: /Upload to S3/i });
  expect(button).toBeDisabled();
});
