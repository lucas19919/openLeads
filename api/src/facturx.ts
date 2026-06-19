import type { FullDocument } from './documents'
import type { SettingsRow } from './db'

// ZUGFeRD 2.x / Factur-X — EN 16931 (COMFORT) profile.
// We generate the Cross Industry Invoice (CII) XML that gets embedded into the
// PDF/A-3, plus the XMP metadata block that declares the hybrid to readers.

const PROFILE_ID = 'urn:cen.eu:en16931:2017'
export const FACTURX_FILENAME = 'factur-x.xml'

function esc(s: string | null | undefined): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// cents → "1234.56" (CII uses a dot decimal, two places).
function amt(cents: number): string {
  return (cents / 100).toFixed(2)
}

// "YYYY-MM-DD" → "YYYYMMDD" (UNCEFACT date format 102).
function ymd(iso: string | null): string {
  return iso ? iso.replace(/-/g, '') : ''
}

// German trade units → UN/ECE Recommendation 20 unit codes.
function unitCode(unit: string | null): string {
  const u = (unit ?? '').toLowerCase()
  if (u.startsWith('std') || u.startsWith('stund') || u === 'h') return 'HUR'
  if (u.startsWith('monat') || u === 'mon') return 'MON'
  if (u.startsWith('tag')) return 'DAY'
  if (u.startsWith('km')) return 'KMT'
  if (u.startsWith('m2') || u.includes('qm')) return 'MTK'
  return 'C62' // piece / one (default, incl. Stück & Pauschal)
}

// A Steuernummer goes in as a tax number (FC); a USt-IdNr (DExxxxxxxxx) as VAT (VA).
function taxScheme(taxId: string | null): 'VA' | 'FC' {
  return taxId && /^DE\d{9}$/i.test(taxId.replace(/\s/g, '')) ? 'VA' : 'FC'
}

/**
 * Build the EN 16931 CII XML for a finalised Rechnung. Caller must ensure the
 * document is a numbered invoice (kind 'rechnung' with a number + issue_date).
 */
export function buildFacturXXml(doc: FullDocument, s: SettingsRow): string {
  const exempt = !!doc.small_business
  const categoryCode = exempt ? 'E' : 'S'
  const ratePercent = exempt ? '0' : String(doc.vat_rate)
  const t = doc.totals

  const lines = doc.items
    .map((it, i) => {
      const lineNet = Math.round(it.quantity * it.unit_price_cents)
      return `    <ram:IncludedSupplyChainTradeLineItem>
      <ram:AssociatedDocumentLineDocument><ram:LineID>${i + 1}</ram:LineID></ram:AssociatedDocumentLineDocument>
      <ram:SpecifiedTradeProduct><ram:Name>${esc(it.description) || 'Position'}</ram:Name></ram:SpecifiedTradeProduct>
      <ram:SpecifiedLineTradeAgreement>
        <ram:NetPriceProductTradePrice><ram:ChargeAmount>${amt(it.unit_price_cents)}</ram:ChargeAmount></ram:NetPriceProductTradePrice>
      </ram:SpecifiedLineTradeAgreement>
      <ram:SpecifiedLineTradeDelivery><ram:BilledQuantity unitCode="${unitCode(it.unit)}">${it.quantity}</ram:BilledQuantity></ram:SpecifiedLineTradeDelivery>
      <ram:SpecifiedLineTradeSettlement>
        <ram:ApplicableTradeTax>
          <ram:TypeCode>VAT</ram:TypeCode>
          <ram:CategoryCode>${categoryCode}</ram:CategoryCode>
          <ram:RateApplicablePercent>${ratePercent}</ram:RateApplicablePercent>
        </ram:ApplicableTradeTax>
        <ram:SpecifiedTradeSettlementLineMonetarySummation><ram:LineTotalAmount>${amt(lineNet)}</ram:LineTotalAmount></ram:SpecifiedTradeSettlementLineMonetarySummation>
      </ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>`
    })
    .join('\n')

  const headerTax = `      <ram:ApplicableTradeTax>
        <ram:CalculatedAmount>${amt(t.vat_cents)}</ram:CalculatedAmount>
        <ram:TypeCode>VAT</ram:TypeCode>${
          exempt
            ? `\n        <ram:ExemptionReason>Steuerbefreiung gemäß § 19 UStG (Kleinunternehmer)</ram:ExemptionReason>`
            : ''
        }
        <ram:BasisAmount>${amt(t.net_cents)}</ram:BasisAmount>
        <ram:CategoryCode>${categoryCode}</ram:CategoryCode>
        <ram:RateApplicablePercent>${ratePercent}</ram:RateApplicablePercent>
      </ram:ApplicableTradeTax>`

  const iban = (s.iban ?? '').replace(/\s/g, '')
  const paymentMeans = iban
    ? `      <ram:SpecifiedTradeSettlementPaymentMeans>
        <ram:TypeCode>58</ram:TypeCode>
        <ram:PayeePartyCreditorFinancialAccount><ram:IBANID>${esc(iban)}</ram:IBANID></ram:PayeePartyCreditorFinancialAccount>
      </ram:SpecifiedTradeSettlementPaymentMeans>\n`
    : ''

  const paymentTerms = doc.due_date
    ? `      <ram:SpecifiedTradePaymentTerms><ram:DueDateDateTime><udt:DateTimeString format="102">${ymd(
        doc.due_date,
      )}</udt:DateTimeString></ram:DueDateDateTime></ram:SpecifiedTradePaymentTerms>\n`
    : ''

  const sellerTax = s.tax_id
    ? `        <ram:SpecifiedTaxRegistration><ram:ID schemeID="${taxScheme(s.tax_id)}">${esc(
        s.tax_id.replace(/\s/g, ''),
      )}</ram:ID></ram:SpecifiedTaxRegistration>\n`
    : ''

  return `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100" xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
  <rsm:ExchangedDocumentContext>
    <ram:GuidelineSpecifiedDocumentContextParameter><ram:ID>${PROFILE_ID}</ram:ID></ram:GuidelineSpecifiedDocumentContextParameter>
  </rsm:ExchangedDocumentContext>
  <rsm:ExchangedDocument>
    <ram:ID>${esc(doc.number)}</ram:ID>
    <ram:TypeCode>380</ram:TypeCode>
    <ram:IssueDateTime><udt:DateTimeString format="102">${ymd(doc.issue_date)}</udt:DateTimeString></ram:IssueDateTime>
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
${lines}
    <ram:ApplicableHeaderTradeAgreement>
${doc.buyer_reference ? `      <ram:BuyerReference>${esc(doc.buyer_reference)}</ram:BuyerReference>\n` : ''}      <ram:SellerTradeParty>
        <ram:Name>${esc(s.business_name) || 'Verkäufer'}</ram:Name>
        <ram:PostalTradeAddress>
          <ram:PostcodeCode>${esc(s.zip)}</ram:PostcodeCode>
          <ram:LineOne>${esc(s.address)}</ram:LineOne>
          <ram:CityName>${esc(s.city)}</ram:CityName>
          <ram:CountryID>DE</ram:CountryID>
        </ram:PostalTradeAddress>
${s.email ? `        <ram:URIUniversalCommunication><ram:URIID schemeID="EM">${esc(s.email)}</ram:URIID></ram:URIUniversalCommunication>\n` : ''}${sellerTax}      </ram:SellerTradeParty>
      <ram:BuyerTradeParty>
        <ram:Name>${esc(doc.client_name) || 'Kunde'}</ram:Name>
        <ram:PostalTradeAddress>
          <ram:PostcodeCode>${esc(doc.client_zip)}</ram:PostcodeCode>
          <ram:LineOne>${esc(doc.client_address)}</ram:LineOne>
          <ram:CityName>${esc(doc.client_city)}</ram:CityName>
          <ram:CountryID>DE</ram:CountryID>
        </ram:PostalTradeAddress>
      </ram:BuyerTradeParty>
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeDelivery/>
    <ram:ApplicableHeaderTradeSettlement>
      <ram:PaymentReference>${esc(doc.number)}</ram:PaymentReference>
      <ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>
${paymentMeans}${headerTax}
${paymentTerms}      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:LineTotalAmount>${amt(t.net_cents)}</ram:LineTotalAmount>
        <ram:TaxBasisTotalAmount>${amt(t.net_cents)}</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount currencyID="EUR">${amt(t.vat_cents)}</ram:TaxTotalAmount>
        <ram:GrandTotalAmount>${amt(t.gross_cents)}</ram:GrandTotalAmount>
        <ram:DuePayableAmount>${amt(t.gross_cents)}</ram:DuePayableAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>`
}

/**
 * XMP metadata declaring the PDF a Factur-X/ZUGFeRD hybrid (EN 16931 profile),
 * including the PDF/A extension-schema description that veraPDF expects.
 * Appended into pdfkit's RDF block via doc.appendXML().
 */
export const FACTURX_XMP = `
<rdf:Description rdf:about="" xmlns:fx="urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#">
  <fx:DocumentType>INVOICE</fx:DocumentType>
  <fx:DocumentFileName>${FACTURX_FILENAME}</fx:DocumentFileName>
  <fx:Version>1.0</fx:Version>
  <fx:ConformanceLevel>EN 16931</fx:ConformanceLevel>
</rdf:Description>
<rdf:Description rdf:about="" xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/" xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#" xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#">
  <pdfaExtension:schemas>
    <rdf:Bag>
      <rdf:li rdf:parseType="Resource">
        <pdfaSchema:schema>Factur-X PDFA Extension Schema</pdfaSchema:schema>
        <pdfaSchema:namespaceURI>urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#</pdfaSchema:namespaceURI>
        <pdfaSchema:prefix>fx</pdfaSchema:prefix>
        <pdfaSchema:property>
          <rdf:Seq>
            <rdf:li rdf:parseType="Resource"><pdfaProperty:name>DocumentFileName</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>Name of the embedded XML invoice file</pdfaProperty:description></rdf:li>
            <rdf:li rdf:parseType="Resource"><pdfaProperty:name>DocumentType</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>INVOICE</pdfaProperty:description></rdf:li>
            <rdf:li rdf:parseType="Resource"><pdfaProperty:name>Version</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>The actual version of the Factur-X XML schema</pdfaProperty:description></rdf:li>
            <rdf:li rdf:parseType="Resource"><pdfaProperty:name>ConformanceLevel</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>The conformance level of the embedded Factur-X data</pdfaProperty:description></rdf:li>
          </rdf:Seq>
        </pdfaSchema:property>
      </rdf:li>
    </rdf:Bag>
  </pdfaExtension:schemas>
</rdf:Description>`
