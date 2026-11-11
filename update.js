function handlePaymentSubmit() {
    updateTicker("Redirecting to secure Jentlestay billing vault...");
    
    const remainingSlots = 102;
    let stripeUrl = "";
    
    if (remainingSlots > 0) {
        // 💳 PLACE YOUR REAL LIVE $2.00 LIFETIME PRODUCTION LINK HERE:
        stripeUrl = "https://stripe.com";
    } else {
        // 🔄 PLACE YOUR REAL LIVE $1.99 RECURRING SUBSCRIPTION LINK HERE:
        stripeUrl = "https://stripe.com";
    }
    
    window.open(stripeUrl, '_blank');
}
