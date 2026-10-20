// Runs only in a CDP isolated world. Return booleans, never field contents.
// This is a conservative form-state check, not an inventory of application JS.
export function inspectDocumentSafety() {
  const visible = field => field.isConnected && field.getClientRects().length > 0
  const inputNodes=document.querySelectorAll('input'),textareaNodes=document.querySelectorAll('textarea'),selectNodes=document.querySelectorAll('select'),editableNodes=document.querySelectorAll('[contenteditable]')
  if(inputNodes.length+textareaNodes.length+selectNodes.length+editableNodes.length>4096)return{ready:false,credentials:false,unsaved:true}
  const allInputs = [...inputNodes], inputs = allInputs.filter(visible)
  // Reconstruct native reset defaults in an inert fresh document. Do not clone
  // site nodes or copy handlers, arbitrary attributes, custom elements or URLs.
  // All radio members are reconstructed under their original form-owner group.
  const inert = document.implementation.createHTMLDocument(''), forms = new Map(), defaults = new Map()
  const append=(parent,child)=>Element.prototype.append.call(parent,child)
  const formFor = field => {const owner=field.form||document;let form=forms.get(owner);if(!form){form=inert.createElement('form');append(inert.body,form);forms.set(owner,form)}return form}
  for(const field of allInputs){const clean=inert.createElement('input');clean.type=field.type;clean.name=field.name;clean.min=field.min;clean.max=field.max;clean.step=field.step;clean.multiple=field.multiple;clean.defaultValue=field.defaultValue;clean.defaultChecked=field.defaultChecked;append(formFor(field),clean);defaults.set(field,clean)}
  const textareas=[...textareaNodes].filter(visible), selects=[...selectNodes].filter(visible)
  if(selects.reduce((count,field)=>count+field.options.length,0)>16384)return{ready:false,credentials:false,unsaved:true}
  for(const field of textareas){const clean=inert.createElement('textarea');clean.defaultValue=field.defaultValue;append(formFor(field),clean);defaults.set(field,clean)}
  for(const field of selects){const clean=inert.createElement('select');clean.multiple=field.multiple;clean.size=field.size;for(const option of field.options){const entry=inert.createElement('option');entry.defaultSelected=option.defaultSelected;entry.disabled=option.disabled||Boolean(option.parentElement?.tagName==='OPTGROUP'&&option.parentElement.disabled);append(clean,entry)}append(formFor(field),clean);defaults.set(field,clean)}
  for(const form of forms.values())HTMLFormElement.prototype.reset.call(form)
  const credentials = inputs.some(field => (field.type === 'password' || (field.autocomplete || '').toLowerCase().split(/\s+/).some(value => ['current-password', 'new-password', 'one-time-code'].includes(value))) && field.value.length > 0)
  const dirtyInput = inputs.some(field => {
    if (['hidden', 'button', 'submit', 'reset', 'image'].includes(field.type)) return false
    const clean=defaults.get(field)
    if (['checkbox', 'radio'].includes(field.type)) return field.checked !== clean.checked
    return field.value !== clean.value
  })
  const dirtySelect = selects.some(field => [...field.options].some((option,index) => option.selected !== defaults.get(field).options[index].selected))
  const dirtyTextarea = textareas.some(field => field.value !== defaults.get(field).value)
  // There is no generic persisted baseline for a contenteditable document.
  const editable = [...editableNodes].filter(visible).some(field => field.isContentEditable && field.textContent.length > 0)
  return { ready: document.readyState === 'complete', credentials, unsaved: dirtyInput || dirtySelect || dirtyTextarea || editable }
}

export const DOCUMENT_SAFETY_EXPRESSION = `(${inspectDocumentSafety.toString()})()`
