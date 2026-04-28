import { Editor } from './components/Editor'
import { HeadlessDocumentRenderer } from './components/HeadlessDocumentRenderer'

function App() {
  if (new URLSearchParams(window.location.search).has('openwpsHeadlessRender')) {
    return <HeadlessDocumentRenderer />
  }
  return <Editor />
}

export default App
